/** Real local workerd/D1 bindings; no production resources or HTTP admin routes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';
import { initializeWorld, getWorld, setWorldStatus, scheduleWorldJob, listWorldJobs,
  WORLD_JOB_BUDGET, type Database } from '../../src/world/runtime.ts';

const DAY = 86_400_000;
const WORLD = 'earth-main';

test('Wrangler local D1 migrations and scheduled Worker integration', { timeout: 120_000 }, async t => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.local.jsonc' }] });
  t.after(async () => { await server.close(); });
  await server.listen();
  const worker = server.getWorker<{ DB: Database }>();
  await worker.applyD1Migrations('DB');
  const { DB: db } = await worker.getEnv();
  const query = async (sql: string, ...values: (string | number | null)[]) => {
    const [result] = await db.batch([db.prepare(sql).bind(...values)]);
    return result!.results;
  };
  const cron = async () => {
    const result = await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() });
    assert.equal(result.outcome, 'ok');
  };

  await t.test('all migrations apply once and Cron does not create or start a world', async () => {
    await worker.applyD1Migrations('DB'); // Applying again is intentionally safe.
    const tables = (await query("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name);
    for (const table of ['characters', 'player_events', 'world_runtime', 'world_ticks', 'world_events', 'world_jobs']) {
      assert.ok(tables.includes(table), `migration must create ${table}`);
    }
    assert.equal((await query('SELECT COUNT(*) AS count FROM d1_migrations'))[0]!.count, 3);
    await cron();
    assert.equal(await getWorld(db, WORLD), null);
    await initializeWorld(db);
    await cron();
    assert.equal((await getWorld(db, WORLD))!.status, 'STOPPED');
    assert.equal((await getWorld(db, WORLD))!.lastTick, 0);
  });

  await t.test('an explicitly started world advances with zero players and concurrent Cron is idempotent', async () => {
    assert.equal((await query('SELECT COUNT(*) AS count FROM characters'))[0]!.count, 0);
    await setWorldStatus(db, WORLD, 'RUNNING', Date.now() - 31 * DAY - 10_000);
    await Promise.all([cron(), cron(), cron()]);
    const state = (await getWorld(db, WORLD))!;
    assert.equal(state.lastTick, 31);
    assert.equal(state.resources, 124);
    assert.equal((await query('SELECT COUNT(*) AS count FROM world_ticks'))[0]!.count, 31);
    assert.equal((await query("SELECT COUNT(*) AS count FROM world_events WHERE event_type IN ('world.season_changed','world.festival','world.rules_changed')"))[0]!.count, 6);
    const jobs = await listWorldJobs(db, WORLD);
    assert.equal(jobs.filter(job => job.status === 'completed').length, 2);
    assert.equal((await query("SELECT COUNT(*) AS count FROM world_events WHERE event_type IN ('world.research_activity','world.research_report')"))[0]!.count, 2);
    const history = await query('SELECT * FROM world_events ORDER BY tick_index, event_key');
    await cron();
    assert.deepEqual(await query('SELECT * FROM world_events ORDER BY tick_index, event_key'), history);
  });

  await t.test('D1 delayed jobs remain unique and excess due work survives the per-tick budget', async () => {
    for (let i = 0; i <= WORLD_JOB_BUDGET; i++) {
      const command = { idempotencyKey: `d1-budget-${i}`, dueTick: 32, type: 'world.research_report' as const,
        payload: { region: 'd1-region', topic: 'offline public research' }, ruleVersion: 1 };
      await scheduleWorldJob(db, WORLD, command);
      await scheduleWorldJob(db, WORLD, command);
    }
    await db.batch([db.prepare('UPDATE world_runtime SET epoch_ms=? WHERE world_id=?').bind(Date.now() - 33 * DAY - 10_000, WORLD)]);
    await Promise.all([cron(), cron()]);
    const jobs = (await listWorldJobs(db, WORLD)).filter(job => job.idempotencyKey.startsWith('d1-budget-'));
    assert.equal(jobs.length, WORLD_JOB_BUDGET + 1);
    assert.ok(jobs.every(job => job.status === 'completed' && job.attempts === 1));
    assert.equal(jobs.filter(job => job.completedTick === 32).length, WORLD_JOB_BUDGET);
    assert.equal(jobs.filter(job => job.completedTick === 33).length, 1);
    assert.equal((await query('SELECT COUNT(*) AS count FROM player_events'))[0]!.count, 0);
  });

  await t.test('paused and maintenance worlds do not advance or grant anonymous control', async () => {
    const lastTick = (await getWorld(db, WORLD))!.lastTick;
    for (const status of ['PAUSED', 'MAINTENANCE'] as const) {
      await setWorldStatus(db, WORLD, status, Date.now());
      await cron();
      assert.equal((await getWorld(db, WORLD))!.lastTick, lastTick);
      assert.equal((await getWorld(db, WORLD))!.status, status);
    }
    // The production Worker has no fetch handler, including no local-only admin endpoint.
    await assert.rejects(worker.fetch('/admin/world/start'));
    assert.equal((await getWorld(db, WORLD))!.status, 'MAINTENANCE');
  });

  await t.test('D1 batch reports changes and a losing revision cannot append history', async () => {
    const before = (await getWorld(db, WORLD))!;
    const revision = 'integration-cas-winner';
    const winner = await db.batch([db.prepare('UPDATE world_runtime SET revision_token=? WHERE world_id=? AND revision_token=?')
      .bind(revision, WORLD, before.revision)]);
    assert.equal(winner[0]!.meta?.changes, 1);
    const loser = await db.batch([
      db.prepare('UPDATE world_runtime SET revision_token=? WHERE world_id=? AND revision_token=?')
        .bind('integration-cas-loser', WORLD, before.revision),
      db.prepare(`INSERT INTO world_ticks(world_id,tick_index,rule_version,season,resources_after)
        SELECT ?,999,1,'spring',0 WHERE EXISTS(SELECT 1 FROM world_runtime WHERE world_id=? AND revision_token=?)`)
        .bind(WORLD, WORLD, 'integration-cas-loser')
    ]);
    assert.equal(loser[0]!.meta?.changes, 0);
    assert.equal(loser[1]!.meta?.changes, 0);
    assert.equal((await query('SELECT COUNT(*) AS count FROM world_ticks WHERE tick_index=999'))[0]!.count, 0);
  });

  await t.test('a failing later statement rolls back the complete D1 batch', async () => {
    const before = (await getWorld(db, WORLD))!;
    await assert.rejects(db.batch([
      db.prepare('UPDATE world_runtime SET resources=999, revision_token=? WHERE world_id=?').bind('must-roll-back', WORLD),
      db.prepare(`INSERT INTO world_ticks(world_id,tick_index,rule_version,season,resources_after)
        VALUES(?,999,999,'spring',0)`).bind(WORLD)
    ]), /constraint|FOREIGN KEY/i);
    assert.deepEqual(await getWorld(db, WORLD), before);
    assert.equal((await query('SELECT COUNT(*) AS count FROM world_ticks WHERE tick_index=999'))[0]!.count, 0);
  });
});

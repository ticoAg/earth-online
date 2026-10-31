import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDatabase } from '../scripts/local-sqlite.ts';
import { advanceDueWorld, initializeWorld, getWorld, setWorldStatus, stageRuleSet,
  scheduleWorldJob, listWorldJobs, WORLD_JOB_BUDGET, MAX_JOB_DEPTH, type Database } from '../src/world/runtime.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const WORLD = 'earth-main';
type LocalDatabase = ReturnType<typeof openLocalDatabase>;
const query = async (db: Database, sql: string, ...values: (string | number | null)[]) =>
  (await db.batch([db.prepare(sql).bind(...values)]))[0]!.results;
async function fixture(fn: (db: LocalDatabase, filename: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'earth-jobs-'));
  const filename = join(dir, 'world.sqlite');
  const db = openLocalDatabase(filename);
  try { db.migrate(); await initializeWorld(db); await setWorldStatus(db, WORLD, 'RUNNING', START); await fn(db, filename); }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
const report = (key: string, dueTick = 2) => ({
  idempotencyKey: key, dueTick, type: 'world.research_report' as const,
  payload: { region: 'test-region', topic: 'public mathematics' }, ruleVersion: 1
});

test('zero-player 30 and 100 day histories contain reproducible delayed public event chains', async () => {
  for (const days of [30, 100]) {
    const snapshots: unknown[] = [];
    for (let run = 0; run < 2; run++) await fixture(async db => {
      let result = await advanceDueWorld(db, WORLD, START + days * DAY, 17);
      while (result.backlog) result = await advanceDueWorld(db, WORLD, START + days * DAY, 17);
      const events = await query(db, 'SELECT tick_index,event_key,event_type,rule_version,payload_json FROM world_events ORDER BY tick_index,event_key');
      const delayed = events.filter(row => ['world.research_activity', 'world.research_report'].includes(String(row.event_type)));
      assert.ok(delayed.length >= (days === 30 ? 2 : 6));
      assert.equal((await query(db, 'SELECT COUNT(*) AS count FROM characters'))[0]!.count, 0);
      assert.equal((await query(db, 'SELECT COUNT(*) AS count FROM player_events'))[0]!.count, 0);
      const jobs = await listWorldJobs(db, WORLD);
      for (const job of jobs.filter(item => item.status === 'completed')) {
        assert.ok(job.sourceTick !== null && job.sourceEventKey);
        assert.ok(job.completedTick! >= job.dueTick);
        assert.equal(job.ruleVersion, 1);
        assert.equal(job.attempts, 1);
        assert.equal((await query(db, 'SELECT COUNT(*) AS count FROM world_events WHERE world_id=? AND tick_index=? AND event_key=?',
          WORLD, job.sourceTick, job.sourceEventKey))[0]!.count, 1);
      }
      const before = JSON.stringify(events);
      await advanceDueWorld(db, WORLD, START + days * DAY);
      assert.equal(JSON.stringify(await query(db, 'SELECT tick_index,event_key,event_type,rule_version,payload_json FROM world_events ORDER BY tick_index,event_key')), before);
      snapshots.push(events);
    });
    assert.deepEqual(snapshots[0], snapshots[1], `${days} day history should be reproducible`);
  }
});

test('scheduled jobs are idempotent, reject conflicting content and retain their origin rule version', async () => fixture(async db => {
  await advanceDueWorld(db, WORLD, START + DAY);
  const command = { ...report('manual-report'), sourceEvent: { tick: 1, eventKey: 'world.season_changed' } };
  await scheduleWorldJob(db, WORLD, command);
  await scheduleWorldJob(db, WORLD, command);
  assert.equal((await listWorldJobs(db, WORLD)).filter(job => job.idempotencyKey === command.idempotencyKey).length, 1);
  await assert.rejects(scheduleWorldJob(db, WORLD, { ...command, dueTick: 3 }), /conflict/);
  await stageRuleSet(db, WORLD, { version: 2, effectiveTick: 2, seasonLengthTicks: 30, resourcePerTick: 5, festivalEveryTicks: 7 });
  await advanceDueWorld(db, WORLD, START + 2 * DAY);
  const job = (await listWorldJobs(db, WORLD)).find(item => item.idempotencyKey === command.idempotencyKey)!;
  assert.equal(job.status, 'completed');
  assert.equal(job.ruleVersion, 1);
  const events = await query(db, "SELECT rule_version FROM world_events WHERE tick_index=2 AND event_type='world.research_report'");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.rule_version, 1);
}));

test('overdue jobs exceeding a tick budget remain pending and execute on a later tick', async () => fixture(async db => {
  await advanceDueWorld(db, WORLD, START + DAY);
  for (let i = 0; i < WORLD_JOB_BUDGET + 1; i++) await scheduleWorldJob(db, WORLD, report(`budget-${String(i).padStart(3, '0')}`));
  await advanceDueWorld(db, WORLD, START + 2 * DAY);
  let jobs = (await listWorldJobs(db, WORLD)).filter(job => job.idempotencyKey.startsWith('budget-'));
  assert.equal(jobs.filter(job => job.status === 'completed').length, WORLD_JOB_BUDGET);
  assert.equal(jobs.filter(job => job.status === 'pending').length, 1);
  await advanceDueWorld(db, WORLD, START + 3 * DAY);
  jobs = (await listWorldJobs(db, WORLD)).filter(job => job.idempotencyKey.startsWith('budget-'));
  assert.ok(jobs.every(job => job.status === 'completed'));
  assert.equal(jobs.filter(job => job.completedTick === 3).length, 1);
}));

test('pending delayed jobs survive concurrent schedulers and frozen world time', async () => fixture(async (db, filename) => {
  await advanceDueWorld(db, WORLD, START + DAY);
  await scheduleWorldJob(db, WORLD, report('survive-restart', 3));
  await setWorldStatus(db, WORLD, 'PAUSED', START + DAY);
  const restarted = openLocalDatabase(filename);
  try {
    await setWorldStatus(restarted, WORLD, 'MAINTENANCE', START + 5 * DAY);
    assert.equal((await advanceDueWorld(restarted, WORLD, START + 50 * DAY)).processed, 0);
    assert.equal((await listWorldJobs(restarted, WORLD)).find(job => job.idempotencyKey === 'survive-restart')!.status, 'pending');
    await setWorldStatus(restarted, WORLD, 'RUNNING', START + 50 * DAY);
    assert.equal((await advanceDueWorld(restarted, WORLD, START + 50 * DAY)).processed, 0);
    await Promise.all([advanceDueWorld(db, WORLD, START + 52 * DAY), advanceDueWorld(restarted, WORLD, START + 52 * DAY)]);
    const job = (await listWorldJobs(restarted, WORLD)).find(item => item.idempotencyKey === 'survive-restart')!;
    assert.equal(job.status, 'completed');
    assert.equal(job.completedTick, 3);
    assert.equal(job.attempts, 1);
    assert.equal((await query(db, "SELECT COUNT(*) AS count FROM world_events WHERE event_type='world.research_report'"))[0]!.count, 1);
  } finally { restarted.close(); }
}));

test('closing and reopening all SQLite connections preserves pending jobs and their causal chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'earth-jobs-restart-'));
  const filename = join(dir, 'world.sqlite');
  let db = openLocalDatabase(filename);
  try {
    db.migrate();
    await initializeWorld(db);
    await setWorldStatus(db, WORLD, 'RUNNING', START);
    await advanceDueWorld(db, WORLD, START + DAY);
    const pending = await listWorldJobs(db, WORLD);
    assert.equal(pending.length, 1);
    db.close();
    db = openLocalDatabase(filename);
    assert.deepEqual(await listWorldJobs(db, WORLD), pending);
    await advanceDueWorld(db, WORLD, START + 11 * DAY);
    const activity = (await listWorldJobs(db, WORLD)).find(job => job.type === 'world.research_activity')!;
    assert.equal(activity.status, 'completed');
    db.close();
    db = openLocalDatabase(filename);
    await advanceDueWorld(db, WORLD, START + 16 * DAY);
    const jobs = await listWorldJobs(db, WORLD);
    assert.equal(jobs.filter(job => job.status === 'completed').length, 2);
    assert.ok(jobs.every(job => job.attempts === 1));
    assert.equal(jobs.find(job => job.type === 'world.research_report')!.rootKey, activity.rootKey);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid stored jobs retry a finite number of logical ticks without blocking valid work', async () => fixture(async db => {
  await advanceDueWorld(db, WORLD, START + DAY);
  await scheduleWorldJob(db, WORLD, report('bad-report'));
  await scheduleWorldJob(db, WORLD, report('good-report'));
  await db.batch([db.prepare('UPDATE world_jobs SET payload_json=? WHERE world_id=? AND idempotency_key=?').bind('{}', WORLD, 'bad-report')]);
  await advanceDueWorld(db, WORLD, START + 2 * DAY);
  let bad = (await listWorldJobs(db, WORLD)).find(job => job.idempotencyKey === 'bad-report')!;
  assert.equal(bad.status, 'pending');
  assert.equal(bad.attempts, 1);
  assert.ok(bad.lastError);
  assert.equal((await listWorldJobs(db, WORLD)).find(job => job.idempotencyKey === 'good-report')!.status, 'completed');
  await advanceDueWorld(db, WORLD, START + 5 * DAY);
  bad = (await listWorldJobs(db, WORLD)).find(job => job.idempotencyKey === 'bad-report')!;
  assert.equal(bad.status, 'failed');
  assert.equal(bad.attempts, bad.maxAttempts);
  const snapshot = structuredClone(bad);
  await advanceDueWorld(db, WORLD, START + 6 * DAY);
  assert.deepEqual((await listWorldJobs(db, WORLD)).find(job => job.idempotencyKey === 'bad-report'), snapshot);
}));

test('database failure rolls back the tick, job attempt, emitted event and child task together', async () => fixture(async db => {
  await advanceDueWorld(db, WORLD, START + DAY);
  await scheduleWorldJob(db, WORLD, { ...report('atomic-activity'), type: 'world.research_activity', payload: { region: 'test-region', topic: 'atomic research', followUpAfterTicks: 5 } });
  const beforeWorld = await getWorld(db, WORLD);
  const beforeJobs = await listWorldJobs(db, WORLD);
  const beforeEvents = await query(db, 'SELECT * FROM world_events ORDER BY tick_index,event_key');
  const faulty: Database = {
    prepare: sql => db.prepare(sql),
    batch: async statements => {
      if (statements.some(statement => /INSERT INTO world_ticks/.test((statement as unknown as { sql: string }).sql))) {
        return db.batch([...statements, db.prepare('INSERT INTO deliberately_missing_table VALUES (1)')]);
      }
      return db.batch(statements);
    }
  };
  await assert.rejects(advanceDueWorld(faulty, WORLD, START + 2 * DAY), /deliberately_missing_table/);
  assert.deepEqual(await getWorld(db, WORLD), beforeWorld);
  assert.deepEqual(await listWorldJobs(db, WORLD), beforeJobs);
  assert.deepEqual(await query(db, 'SELECT * FROM world_events ORDER BY tick_index,event_key'), beforeEvents);
  await advanceDueWorld(db, WORLD, START + 2 * DAY);
  assert.equal((await listWorldJobs(db, WORLD)).find(job => job.idempotencyKey === 'atomic-activity')!.attempts, 1);
}));

test('public event derivation cannot exceed the configured causal depth', async () => fixture(async db => {
  await advanceDueWorld(db, WORLD, START + DAY);
  let sourceEvent = { tick: 1, eventKey: 'world.season_changed' };
  for (let tick = 2; tick <= MAX_JOB_DEPTH + 3; tick++) {
    const command = { ...report(`depth-${tick}`, tick), sourceEvent };
    await scheduleWorldJob(db, WORLD, command);
    await advanceDueWorld(db, WORLD, START + tick * DAY);
    const job = (await listWorldJobs(db, WORLD)).find(item => item.idempotencyKey === command.idempotencyKey)!;
    assert.ok(job.depth <= MAX_JOB_DEPTH);
    const emitted = (await query(db, "SELECT event_key FROM world_events WHERE tick_index=? AND event_type='world.research_report'", tick))[0]!;
    sourceEvent = { tick, eventKey: String(emitted.event_key) };
    if (job.depth === MAX_JOB_DEPTH) {
      const before = await listWorldJobs(db, WORLD);
      await assert.rejects(scheduleWorldJob(db, WORLD, { ...report('too-deep', tick + 1), sourceEvent }), /depth/);
      assert.deepEqual(await listWorldJobs(db, WORLD), before);
      return;
    }
  }
  assert.fail('expected causal depth limit to be reached');
}));

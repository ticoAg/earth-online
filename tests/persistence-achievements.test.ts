import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type StudyEvent } from '../src/engine.ts';
import { getTimeline } from '../src/projection.ts';
import { insertCharacter, loadWorld, submitPersistedEvent } from '../src/db/repository.ts';
import { openLocalDatabase } from '../scripts/local-sqlite.ts';

const study = (day: number): StudyEvent => ({
  id: `study-${day}`, actorId: 'learner', type: 'study.completed', source: 'self_reported',
  occurredAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00.000Z`, durationMinutes: 60,
  idempotencyKey: day === 2 ? '__proto__' : `request-${day}`,
  payload: { subject: 'math_analysis', method: 'review' }
});

test('persisted learning restores original awards and command snapshots after reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'earth-awards-'));
  const filename = join(dir, 'game.sqlite');
  let db = openLocalDatabase(filename);
  try {
    db.migrate();
    await insertCharacter(db, createWorld('learner', 30, .5, .5));
    const first = await submitPersistedEvent(db, study(2), []);
    assert.deepEqual(first.newAchievements.map(item => item.definitionId), ['first_record']);
    db.close();
    db = openLocalDatabase(filename);
    const loaded = (await loadWorld(db, 'learner'))!;
    assert.deepEqual(loaded.achievements, first.newAchievements);
    assert.equal(loaded.commands?.__proto__?.type, 'study');
    assert.deepEqual(await submitPersistedEvent(db, study(2), []), first);
    assert.deepEqual((await submitPersistedEvent(db, study(3), [])).newAchievements, []);
    const third = await submitPersistedEvent(db, study(5), []);
    assert.deepEqual(third.newAchievements.map(item => item.definitionId), ['steady_practice']);
    assert.deepEqual((await submitPersistedEvent(db, study(6), [])).newAchievements, []);
    const final = (await loadWorld(db, 'learner'))!;
    assert.deepEqual(final.achievements?.map(item => item.definitionId), ['first_record', 'steady_practice']);
    assert.equal(getTimeline(final).filter(item => item.type === 'achievement').length, 2);
    first.newAchievements.length = 0;
    assert.equal((await submitPersistedEvent(db, study(2), [])).newAchievements.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh character insertion refuses unpersisted S1 state instead of dropping it', async () => {
  const db = openLocalDatabase(':memory:');
  try {
    db.migrate();
    const world = createWorld('learner', 30, .5, .5);
    world.achievements = [{ definitionId: 'first_record', version: 1, category: 'ordinary',
      source: 'system_simulated', sourceEventId: 'missing', unlockedAt: study(2).occurredAt }];
    await assert.rejects(() => insertCharacter(db, world), /insert_requires_fresh_world/);
    assert.equal(await loadWorld(db, 'learner'), null);
  } finally { db.close(); }
});

test('pre-S1 result JSON remains replayable without inventing historical awards', async () => {
  const db = openLocalDatabase(':memory:');
  try {
    db.migrate();
    await insertCharacter(db, createWorld('learner', 30, .5, .5));
    const result = await submitPersistedEvent(db, study(2), []);
    const { newAchievements: _awards, ...legacyResult } = result;
    await db.batch([db.prepare('UPDATE player_events SET result_json = ? WHERE id = ?')
      .bind(JSON.stringify(legacyResult), study(2).id)]);
    assert.deepEqual((await loadWorld(db, 'learner'))?.achievements, []);
    assert.deepEqual(await submitPersistedEvent(db, study(2), []), legacyResult);
    const next = await submitPersistedEvent(db, study(3), []);
    assert.equal(next.newAchievements[0]?.sourceEventId, study(3).id);
  } finally { db.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type StudyEvent, type Rule } from '../src/engine.ts';
import { openLocalDatabase } from '../scripts/local-sqlite.ts';
import { insertCharacter, loadWorld, seedSyntheticCharacters, submitPersistedEvent } from '../src/db/repository.ts';

const rule = JSON.parse(readFileSync(new URL('../examples/rules/math-insight.json', import.meta.url), 'utf8')) as Rule;
const event = (i = 1): StudyEvent => ({
  id: `e-${i}`, actorId: 'researcher', type: 'study.completed', source: 'self_reported',
  occurredAt: `2026-01-${String(i + 2).padStart(2, '0')}T10:00:00.000Z`,
  durationMinutes: 90, idempotencyKey: `req-${i}`,
  payload: { subject: 'math_analysis', method: 'cross_domain' }
});
async function fixture(action: (filename: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'earth-online-'));
  try { await action(join(dir, 'game.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('SQLite migration and synthetic seed are repeatable', async () => fixture(async filename => {
  const db = openLocalDatabase(filename);
  try {
    db.migrate(); db.migrate();
    assert.equal(await seedSyntheticCharacters(db, 25), 25);
    assert.equal(await seedSyntheticCharacters(db, 25), 0);
    const world = await loadWorld(db, 'synthetic-0007');
    assert.ok(world);
    assert.equal(world?.accepted.length, 0);
    assert.ok(world!.character.hidden.associativeThinking >= 0);
  } finally { db.close(); }
}));

test('persistence survives reopening; replay never re-rolls', async () => fixture(async filename => {
  let db = openLocalDatabase(filename);
  db.migrate();
  const initial = createWorld('researcher', 75, .6, .6);
  initial.character.researchSessions = 25;
  initial.character.crossDomainLinks = 5;
  await insertCharacter(db, initial);
  let draws = 0;
  const first = await submitPersistedEvent(db, event(), [rule], () => { draws++; return 0; });
  assert.equal(first.createdEncounters.length, 1);
  db.close();
  db = openLocalDatabase(filename);
  try {
    const again = await submitPersistedEvent(db, event(), [rule], () => { throw new Error('redraw'); });
    assert.deepEqual(first, again);
    const world = await loadWorld(db, 'researcher');
    assert.equal(world?.accepted.length, 1);
    assert.equal(world?.attempts.length, 1);
    assert.equal(world?.encounters.length, 1);
    assert.equal(draws, 1);
    await assert.rejects(() => submitPersistedEvent(db, { ...event(), durationMinutes: 60 }, [rule]), /idempotency_key_conflict/);
  } finally { db.close(); }
}));

test('failed roll cannot leave partial writes', async () => fixture(async filename => {
  const db = openLocalDatabase(filename);
  try {
    db.migrate();
    const initial = createWorld('researcher', 75, .6, .6);
    initial.character.researchSessions = 25; initial.character.crossDomainLinks = 5;
    await insertCharacter(db, initial);
    await assert.rejects(() => submitPersistedEvent(db, event(), [rule], () => 1), /invalid_roll/);
    const world = await loadWorld(db, 'researcher');
    assert.equal(world?.accepted.length, 0);
    assert.equal(world?.character.mathAnalysis, 75);
  } finally { db.close(); }
}));

test('concurrent events retry against the latest character revision', async () => fixture(async filename => {
  const db = openLocalDatabase(filename);
  try {
    db.migrate(); await insertCharacter(db, createWorld('researcher', 30, .6, .6));
    const [a, b] = await Promise.all([
      submitPersistedEvent(db, event(1), [], () => .5),
      submitPersistedEvent(db, event(2), [], () => .5)
    ]);
    assert.ok(a.delta > 0 && b.delta > 0);
    assert.equal((await loadWorld(db, 'researcher'))?.accepted.length, 2);
  } finally { db.close(); }
}));

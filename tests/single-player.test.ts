import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, processEvent, resolveEncounter, type EncounterChoice, type Rule, type StudyEvent, type World } from '../src/engine.ts';
import { getTimeline, getPublicCharacter } from '../src/projection.ts';

const RULE: Rule = {
  id: 'guaranteed-lead', version: 4, listen: ['study.completed'],
  require: {all: [{path: 'character.skills.math_analysis', op: 'gte', value: 0}]},
  chance: {model: 'additive', base: 1, cap: 1, modifiers: []},
  limit: {cooldown_days: 14, window_days: 7, max_attempts_per_window: 1},
  effects: [{type: 'encounter.create', encounter_type: 'research_lead'}]
};
const study = (id = 'study-1', day = 2, hour = 10): StudyEvent => ({
  id, actorId: 'p1', type: 'study.completed', source: 'self_reported',
  occurredAt: `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`,
  durationMinutes: 60, idempotencyKey: `request-${id}`,
  payload: {subject: 'math_analysis', method: 'problem_solving'}
});
function withLead() {
  return processEvent(createWorld('p1', 30, .5, .5), study(), [RULE], () => 0);
}
const choice = (world: World, option: EncounterChoice['choice'] = 'continue_research'): EncounterChoice => ({
  id: 'choice-1', actorId: 'p1', encounterId: world.encounters[0]!.id,
  choice: option, occurredAt: '2026-01-02T11:00:00.000Z', idempotencyKey: 'request-choice'
});

test('learning to research choice unlocks sourced achievements without changing learning stats', () => {
  const first = withLead();
  assert.deepEqual(first.result.newAchievements.map(a => a.definitionId), ['first_record']);
  assert.equal(first.world.encounters[0]!.ruleVersion, 4);
  const snapshot = structuredClone(first.world);
  const resolved = resolveEncounter(first.world, choice(first.world));
  assert.deepEqual(first.world, snapshot);
  assert.deepEqual(resolved.world.character, first.world.character);
  assert.equal(resolved.world.accepted.length, 1);
  assert.equal(resolved.world.attempts.length, 1);
  assert.equal(resolved.world.encounters[0]!.status, 'resolved');
  assert.equal(resolved.world.encounters[0]!.choiceEventId, 'choice-1');
  assert.deepEqual(resolved.result.newAchievements.map(a => a.definitionId), ['research_lead']);
  const reward = resolved.result.newAchievements[0]!;
  assert.equal(reward.category, 'hidden');
  assert.equal(reward.source, 'system_simulated');
  assert.equal(reward.sourceEventId, 'choice-1');
  assert.equal(reward.version, 1);
});

test('archiving resolves a lead without awarding the hidden research achievement', () => {
  const {world} = withLead();
  const resolved = resolveEncounter(world, choice(world, 'archive'));
  assert.equal(resolved.world.encounters[0]!.status, 'resolved');
  assert.equal(resolved.world.encounters[0]!.choice, 'archive');
  assert.deepEqual(resolved.result.newAchievements, []);
  assert.ok(!resolved.world.achievements?.some(a => a.definitionId === 'research_lead'));
});

test('choice retries return the first snapshot and command keys cannot be reused', () => {
  const initial = withLead().world;
  const command = choice(initial);
  const first = resolveEncounter(initial, command);
  for (let i = 0; i < 10; i++) {
    const replay = resolveEncounter(first.world, command);
    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(replay.world, first.world);
  }
  assert.equal(first.world.achievements?.filter(a => a.definitionId === 'research_lead').length, 1);
  assert.throws(() => resolveEncounter(first.world, {...command, choice: 'archive'}), /idempotency.*conflict/);
  assert.throws(() => resolveEncounter(first.world, {...command, id: 'choice-2', idempotencyKey: 'another-request'}), /encounter_already_resolved/);
  assert.throws(() => resolveEncounter(initial, {...command, idempotencyKey: study().idempotencyKey}), /idempotency.*conflict/);
  assert.throws(() => processEvent(first.world, {...study('second', 3), idempotencyKey: command.idempotencyKey}, []), /idempotency.*conflict/);
  const expected = structuredClone(first.result);
  first.result.encounter.choice = 'archive';
  first.result.newAchievements.length = 0;
  assert.deepEqual(resolveEncounter(first.world, command).result, expected);
});

test('invalid choices reject atomically, including invalid calendar dates and source end boundary', () => {
  const world = withLead().world;
  const command = choice(world);
  const cases: [Partial<EncounterChoice>, RegExp][] = [
    [{actorId: 'other'}, /actor_mismatch/],
    [{encounterId: 'missing'}, /encounter/],
    [{choice: 'unsupported' as EncounterChoice['choice']}, /choice/],
    [{occurredAt: '2026-02-30T11:00:00.000Z'}, /time/],
    [{occurredAt: '2026-01-02T11:00:00+00:00'}, /time/],
    [{occurredAt: '2026-01-02T10:59:59.999Z'}, /time|source/]
  ];
  for (const [change, error] of cases) {
    const snapshot = structuredClone(world);
    assert.throws(() => resolveEncounter(world, {...command, ...change}), error);
    assert.deepEqual(world, snapshot);
  }
  assert.equal(resolveEncounter(world, command).world.encounters[0]!.status, 'resolved');
});

test('three distinct UTC learning dates unlock accumulation once; same day and retries do not count', () => {
  let world = createWorld('p1', 30, .5, .5);
  const events = [study('day-1', 2), study('same-day', 2, 12), study('day-2', 3)];
  for (const event of events) world = processEvent(world, event, []).world;
  world = processEvent(world, events[2]!, []).world;
  assert.ok(!world.achievements?.some(a => a.definitionId === 'steady_practice'));
  const third = processEvent(world, study('day-3', 5), []);
  assert.deepEqual(third.result.newAchievements.map(a => a.definitionId), ['steady_practice']);
  assert.equal(third.result.newAchievements[0]!.unlockedAt, study('day-3', 5).occurredAt);
  const fourth = processEvent(third.world, study('day-4', 6), []);
  assert.deepEqual(fourth.result.newAchievements, []);
  assert.equal(fourth.world.achievements?.filter(a => a.definitionId === 'first_record').length, 1);
});

test('legacy pending leads recover rule version from attempts and reject missing evidence', () => {
  const legacy = withLead().world;
  delete legacy.encounters[0]!.ruleVersion;
  assert.equal(resolveEncounter(legacy, choice(legacy)).result.encounter.ruleVersion, 4);
  const incomplete = structuredClone(legacy);
  incomplete.attempts = [];
  const snapshot = structuredClone(incomplete);
  assert.throws(() => resolveEncounter(incomplete, choice(incomplete)), /incomplete|version|evidence/);
  assert.deepEqual(incomplete, snapshot);
});

test('timeline preserves first learning delta and separates self reports from game results', () => {
  const first = withLead();
  let world = resolveEncounter(first.world, choice(first.world)).world;
  world = processEvent(world, study('later', 3), []).world;
  const snapshot = structuredClone(world);
  const timeline = getTimeline(world);
  assert.deepEqual(world, snapshot);
  assert.deepEqual(timeline, getTimeline(world));
  assert.equal(new Set(timeline.map(entry => entry.id)).size, timeline.length);
  const learning = timeline.find(entry => entry.type === 'study' && entry.sourceEventId === 'study-1');
  assert.ok(learning);
  assert.equal(learning.delta, first.result.delta);
  assert.equal(learning.durationMinutes, 60);
  for (const entry of timeline) {
    assert.equal(entry.source, entry.type === 'study' ? 'self_reported' : 'system_simulated');
    assert.ok(entry.explanation.length > 0);
    assert.ok(entry.sourceEventId);
  }
  const atStart = timeline.filter(entry => entry.occurredAt === study().occurredAt);
  assert.deepEqual(atStart.map(entry => entry.type), ['study', 'encounter', 'achievement']);
  const encounter = timeline.find(entry => entry.type === 'encounter');
  assert.equal(encounter?.verification, 'unverified');
});

test('public projection exposes only allowed game fields and cannot rewrite internal history', () => {
  const world = withLead().world;
  const view = getPublicCharacter(world);
  assert.deepEqual(Object.keys(view).sort(), ['achievements', 'id', 'mathAnalysis', 'pendingEncounters', 'timeline']);
  const encoded = JSON.stringify(view);
  for (const key of ['hidden', 'learningAdaptation', 'associativeThinking', 'probability', 'roll', 'attempts', 'idempotency', 'commands']) {
    assert.ok(!encoded.includes(`"${key}"`), `must not expose ${key}`);
  }
  assert.equal(view.pendingEncounters.length, 1);
  view.pendingEncounters.length = 0;
  view.achievements.length = 0;
  view.timeline.length = 0;
  assert.equal(getPublicCharacter(world).pendingEncounters.length, 1);
  assert.ok(getPublicCharacter(world).achievements.length > 0);
  const settled = resolveEncounter(world, choice(world)).world;
  assert.equal(getPublicCharacter(settled).pendingEncounters.length, 0);
});

test('legacy worlds without new collections and prototype-like choice keys remain usable', () => {
  const legacy = withLead().world;
  delete legacy.achievements;
  delete legacy.choices;
  delete legacy.commands;
  const command = {...choice(legacy), idempotencyKey: '__proto__'};
  const first = resolveEncounter(legacy, command);
  assert.equal(first.world.choices?.length, 1);
  assert.equal(first.world.achievements?.[0]?.definitionId, 'research_lead');
  assert.deepEqual(resolveEncounter(first.world, command).result, first.result);
  assert.throws(() => processEvent(first.world, {...study('collision', 3), id: command.id}, []), /duplicate_event_id/);
  assert.throws(() => resolveEncounter(legacy, {...command, id: study().id}), /duplicate_event_id/);
});

test('legacy encounter versions match their exact attempt identity and reject ambiguous fallback', () => {
  const world = withLead().world;
  delete world.encounters[0]!.ruleVersion;
  const original = world.attempts[0]!;
  world.attempts = [{...original, version: 5}, original];
  const exact = resolveEncounter(world, choice(world));
  assert.equal(exact.result.encounter.ruleVersion, 4);
  const ambiguous = structuredClone(world);
  ambiguous.encounters[0]!.id = 'legacy-lead-without-version';
  const snapshot = structuredClone(ambiguous);
  assert.throws(() => resolveEncounter(ambiguous, choice(ambiguous)), /incomplete_encounter_state/);
  assert.deepEqual(ambiguous, snapshot);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyProgression, createWorld, evaluateRules, processEvent, validateEvent, validateRule,
  type Rule, type Roll, type StudyEvent, type World } from '../src/engine.ts';

const RULE = JSON.parse(readFileSync(new URL('../examples/rules/math-insight.json', import.meta.url), 'utf8')) as Rule;
const study = (i: number, method: StudyEvent['payload']['method'] = 'problem_solving', day = i + 2): StudyEvent => ({
  id: `ev-${i}`, actorId: 'p1', type: 'study.completed', source: 'self_reported',
  occurredAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  durationMinutes: 90, idempotencyKey: `req-${i}`, payload: { subject: 'math_analysis', method }
});
const advanced = (): World => ({
  ...createWorld('p1', 75, .6, .6),
  character: { ...createWorld('p1', 75, .6, .6).character,
    researchSessions: 25, crossDomainLinks: 5 }
});

test('loads documented JSON rule and computes 5% opportunity', () => {
  validateRule(RULE);
  const candidate = evaluateRules(advanced().character, study(1, 'cross_domain'), [RULE]);
  assert.equal(candidate.length, 1);
  assert.ok(Math.abs(candidate[0]!.probability - .05) < 1e-10);
});

test('progression is pure, bounded, and varies with hidden adaptation', () => {
  const slow = createWorld('p1', 40, .1, .4).character;
  const fast = createWorld('p1', 40, .9, .4).character;
  const a = applyProgression(slow, study(1));
  const b = applyProgression(fast, study(1));
  assert.equal(slow.mathAnalysis, 40);
  assert.ok(a.delta > 0 && b.delta > a.delta);
  assert.ok(a.character.mathAnalysis <= 100 && b.character.mathAnalysis <= 100);
  assert.equal(a.character.researchSessions, 1);
});

test('rejects invalid duration, time zone, actor and duplicate time ranges', () => {
  const world = createWorld('p1', 30, .5, .5);
  assert.deepEqual(validateEvent(world, study(1)), []);
  assert.ok(validateEvent(world, {...study(1), durationMinutes: 300}).includes('invalid_duration'));
  assert.ok(validateEvent(world, {...study(1), actorId: 'other'}).includes('actor_mismatch'));
  assert.ok(validateEvent(world, {...study(1), occurredAt: '2026-01-03T10:00:00+00:00'}).includes('invalid_time'));
  const one = processEvent(world, study(1), [RULE], () => .5).world;
  assert.ok(validateEvent(one, {...study(2), occurredAt: study(1).occurredAt}).includes('overlaps_existing_event'));
});

test('idempotency: re-submitting same key does not increase stats or re-roll', () => {
  let count = 0;
  const roll: Roll = () => { count += 1; return 0; };
  const event = study(1);
  const once = processEvent(advanced(), event, [RULE], roll);
  const twice = processEvent(once.world, event, [RULE], roll);
  assert.equal(count, 1);
  assert.equal(once.world, twice.world);
  assert.deepEqual(once.result, twice.result);
  assert.equal(twice.world.encounters.length, 1);
  assert.equal(twice.world.attempts.length, 1);
  assert.equal(twice.world.accepted.length, 1);
});

test('caller mutations do not rewrite the accepted event or stored replay result', () => {
  const event = study(1);
  const { world, result } = processEvent(advanced(), event, [RULE], () => 0);
  event.payload.method = 'review';
  result.createdEncounters[0]!.status = 'pending_choice';
  result.createdEncounters.length = 0;
  assert.equal(world.accepted[0]!.payload.method, 'problem_solving');
  assert.equal(world.encounters.length, 1);
  assert.equal(world.idempotency['req-1']!.createdEncounters.length, 1);
  assert.equal(world.encounters[0]!.verification, 'unverified');
});

test('rejects a reused key with different input and honors disabled rules', () => {
  const event = study(1);
  const { world } = processEvent(advanced(), event, [RULE], () => .8);
  assert.throws(() => processEvent(world, { ...event, durationMinutes: 60 }, [RULE]), /idempotency_key_conflict/);
  assert.deepEqual(evaluateRules(advanced().character, event, [{...RULE, enabled: false}]), []);
});

test('accepts the documented UTC timestamp without fractional seconds', () => {
  const event = {...study(1), occurredAt: '2026-01-03T10:00:00Z'};
  assert.deepEqual(validateEvent(createWorld('p1', 30, .5, .5), event), []);
});

test('missed opportunity obeys one-attempt-per-seven-days', () => {
  const w = advanced();
  const first = processEvent(w, study(1, 'problem_solving', 3), [RULE], () => .95);
  const second = processEvent(first.world, study(2, 'problem_solving', 4), [RULE], () => .95);
  assert.equal(second.world.attempts.length, 1);
  const next = processEvent(second.world, study(3, 'problem_solving', 12), [RULE], () => .95);
  assert.equal(next.world.attempts.length, 2);
  assert.equal(next.world.encounters.length, 0);
});

test('successful opportunity obeys cooldown and marks simulated provenance', () => {
  const first = processEvent(advanced(), study(1, 'cross_domain', 3), [RULE], () => 0);
  assert.equal(first.world.encounters[0]?.source, 'system_simulated');
  const early = processEvent(first.world, study(2, 'problem_solving', 12), [RULE], () => 0);
  assert.equal(early.world.attempts.length, 1);
  const later = processEvent(early.world, study(3, 'problem_solving', 18), [RULE], () => 0);
  assert.equal(later.world.attempts.length, 2);
});

test('prior knowledge gates insights even if the random source always returns zero', () => {
  const fresh = createWorld('p1', 12, .6, .9);
  const outcome = processEvent(fresh, study(1), [RULE], () => 0);
  assert.equal(outcome.world.attempts.length, 0);
  assert.equal(outcome.world.encounters.length, 0);
  assert.ok(outcome.world.character.mathAnalysis > 12);
});

test('rejects rule config that would allow arbitrary paths or invalid probability', () => {
  assert.throws(() => validateRule({...RULE, chance: {...RULE.chance, cap: 1.8}}), /invalid_probability/);
  const modified = structuredClone(RULE) as unknown as {require:{all:{path:string;op:string;value:number}[]}};
  modified.require.all[0]!.path = 'character.hidden.secrets';
  assert.throws(() => validateRule(modified as Rule), /invalid_path/);
});

test('cross-domain activity eventually establishes game knowledge links', () => {
  let w = createWorld('p1', 45, .6, .6);
  for (let i = 0; i < 3; i++) w = processEvent(w, study(i + 1, 'cross_domain', i + 2), [], () => .9).world;
  assert.equal(w.character.crossDomainSessions, 3);
  assert.equal(w.character.crossDomainLinks, 1);
});

test('never mutates the previously passed world state', () => {
  const world = advanced();
  const snapshot = JSON.stringify(world);
  processEvent(world, study(1), [RULE], () => .2);
  assert.equal(JSON.stringify(world), snapshot);
});

test('special idempotency keys do not read inherited Object prototype properties', () => {
  const event = {...study(1), idempotencyKey: '__proto__'};
  const one = processEvent(createWorld('p1', 20, .5, .5), event, [RULE], () => .8);
  const two = processEvent(one.world, event, [RULE], () => .8);
  assert.equal(two.result.eventId, event.id);
  assert.equal(two.world.accepted.length, 1);
});

test('idempotency cannot expose another actor\'s result', () => {
  const event = study(1);
  const once = processEvent(createWorld('p1', 30, .5, .5), event, [RULE], () => .8);
  assert.throws(() => processEvent(once.world, {...event, actorId: 'p2'}, [RULE], () => .8), /actor_mismatch/);
});

test('the same rule identity cannot be supplied twice for one source event', () => {
  const unlimited = {...RULE, limit: {cooldown_days: 0, window_days: 1, max_attempts_per_window: 10}};
  let draws = 0;
  assert.throws(() => processEvent(advanced(), study(1), [unlimited, structuredClone(unlimited)], () => { draws++; return .9; }), /duplicate_rule/);
  assert.equal(draws, 0);
});

test('rejects non-finite and incompatible condition values and unnormalized modifiers', () => {
  const badValue = structuredClone(RULE);
  badValue.require.all[0]!.value = Number.NaN;
  assert.throws(() => validateRule(badValue), /invalid/);
  const badType = structuredClone(RULE);
  badType.require.all[0]!.value = true;
  assert.throws(() => validateRule(badType), /invalid/);
  const badModifier = structuredClone(RULE);
  badModifier.chance.modifiers[0]!.path = 'character.skills.math_analysis';
  assert.throws(() => validateRule(badModifier), /invalid/);
});

test('invalid duration is reported rather than crashing date handling', () => {
  const invalid = {...study(1), durationMinutes: Number.NaN};
  assert.ok(validateEvent(createWorld('p1', 30, .5, .5), invalid).includes('invalid_duration'));
});

test('unmet prerequisites do not call the random source', () => {
  const result = processEvent(createWorld('p1', 0, .5, .5), study(1), [RULE], () => {
    assert.fail('ineligible event must not draw');
  });
  assert.equal(result.world.attempts.length, 0);
});

test('trigger requires roll strictly less than probability, including zero and cap', () => {
  const atCap: Rule = {...RULE, chance: {...RULE.chance, base: .9}};
  assert.equal(evaluateRules(advanced().character, study(1), [atCap])[0]!.probability, .08);
  const equal = processEvent(advanced(), study(1), [atCap], () => .08);
  const below = processEvent(advanced(), study(1), [atCap], () => .079999);
  assert.equal(equal.world.attempts[0]!.triggered, false);
  assert.equal(below.world.attempts[0]!.triggered, true);
  const zero: Rule = {...RULE, chance: {...RULE.chance, base: 0, modifiers: []}};
  assert.equal(processEvent(advanced(), study(1), [zero], () => 0).world.attempts[0]!.triggered, false);
});

test('quota expires exactly after seven days and cooldown exactly after fourteen', () => {
  const missed = processEvent(advanced(), study(1, 'problem_solving', 3), [RULE], () => .9);
  const beforeWindow = {...study(2, 'problem_solving', 10), occurredAt: '2026-01-10T09:59:59.999Z'};
  const before = processEvent(missed.world, beforeWindow, [RULE], () => { assert.fail('window still active'); });
  const boundary = processEvent(before.world, study(3, 'problem_solving', 11), [RULE], () => .9);
  // The accepted intermediate event is on Jan 10; a fresh replay verifies the exact boundary.
  const exact = processEvent(missed.world, study(4, 'problem_solving', 10), [RULE], () => .9);
  assert.equal(before.world.attempts.length, 1);
  assert.equal(boundary.world.attempts.length, 2);
  assert.equal(exact.world.attempts.length, 2);

  const success = processEvent(advanced(), study(5, 'problem_solving', 3), [RULE], () => 0);
  const almost = {...study(6, 'problem_solving', 17), occurredAt: '2026-01-17T09:59:59.999Z'};
  const inCooldown = processEvent(success.world, almost, [RULE], () => { assert.fail('cooldown still active'); });
  const atCooldown = processEvent(success.world, study(7, 'problem_solving', 17), [RULE], () => 0);
  assert.equal(inCooldown.world.attempts.length, 1);
  assert.equal(atCooldown.world.attempts.length, 2);
});

test('a failed roll leaves the input world untouched and historical replay survives a rule change', () => {
  const initial = advanced();
  const snapshot = JSON.stringify(initial);
  assert.throws(() => processEvent(initial, study(1), [RULE], () => 1), /invalid_roll/);
  assert.equal(JSON.stringify(initial), snapshot);
  const first = processEvent(initial, study(1), [RULE], () => 0);
  const newer = {...RULE, version: RULE.version + 1, chance: {...RULE.chance, base: 0, modifiers: []}};
  const replay = processEvent(first.world, study(1), [newer], () => { assert.fail('replay must not redraw'); });
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.world.attempts[0]!.version, RULE.version);
});

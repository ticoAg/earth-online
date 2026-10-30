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
  assert.equal(once.result, twice.result);
  assert.equal(twice.world.encounters.length, 1);
  assert.equal(twice.world.attempts.length, 1);
  assert.equal(twice.world.accepted.length, 1);
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

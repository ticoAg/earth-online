/** Synthetic, offline balance experiment. None of these results describe real people. */
import { readFileSync } from 'node:fs';
import { createWorld, evaluateRules, processEvent, type Method, type Rule, type StudyEvent, type Roll } from '../src/engine.ts';

const rule = JSON.parse(readFileSync(new URL('../examples/rules/math-insight.json', import.meta.url), 'utf8')) as Rule;
const DAY = 86_400_000;
const COUNT = 1000;
const DAYS = 120;
const start = Date.UTC(2026, 0, 2, 10);

// FNV-1a plus a final avalanche: stable across runs, but deliberately not cryptographic.
// This public test generator must never be used to award production rewards.
function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
function unit(seed: string, label: string): number {
  return hash32(`${seed}|${label}`) / 0x1_0000_0000;
}
const round = (value: number): number => Number(value.toFixed(4));

type Group = { characters: number; withLead: number; leads: number; attempts: number };
function group(): Group { return { characters: 0, withLead: 0, leads: 0, attempts: 0 }; }

function simulate(seed: string, scenario: 'mixed' | 'no_cross_domain') {
  let attempts = 0, leads = 0, eligibleEvents = 0, suppressedEvents = 0;
  let reachedSkill = 0, reachedSessions = 0, reachedLinks = 0, eligibleCharacters = 0;
  let minSkill = Infinity, maxSkill = -Infinity, sumSkill = 0;
  const distribution = { zero: 0, one: 0, twoOrMore: 0 };
  const lowAssociation = group(), highAssociation = group();
  const roll: Roll = key => unit(seed, `roll|${key}`);

  for (let person = 0; person < COUNT; person++) {
    // Matched initial values and event IDs across scenarios make the comparison paired.
    const id = `synthetic-${person}`;
    const initialSkill = 25 + 15 * unit(seed, `initial|${person}`);
    const adaptation = .15 + .75 * unit(seed, `adapt|${person}`);
    const association = .15 + .75 * unit(seed, `assoc|${person}`);
    let world = createWorld(id, initialSkill, adaptation, association);
    let hadEligibleEvent = false;
    for (let day = 0; day < DAYS; day++) {
      const method: Method = scenario === 'mixed' && day % 4 === 0 ? 'cross_domain'
        : day % 5 === 0 ? 'review' : 'problem_solving';
      const event: StudyEvent = {
        id: `${id}-day-${day}`, actorId: id, type: 'study.completed',
        // These are generated inputs in a toy world, never real self-reports.
        source: 'self_reported', occurredAt: new Date(start + day * DAY).toISOString(),
        durationMinutes: 90, idempotencyKey: `${id}-study-${day}`,
        payload: { subject: 'math_analysis', method }
      };
      const previous = world;
      const processed = processEvent(previous, event, [rule], roll);
      world = processed.world;
      const eligible = evaluateRules(world.character, event, [rule]).length > 0;
      if (eligible) {
        hadEligibleEvent = true;
        eligibleEvents++;
        if (processed.result.attemptedRules.length === 0) suppressedEvents++;
      }
    }
    // Guard against a burst of attempts and ensure success creates only simulated leads.
    for (let i = 0; i < world.attempts.length; i++) {
      const current = world.attempts[i]!;
      const prior = world.attempts.slice(0, i);
      if (prior.filter(a => Date.parse(current.at) - Date.parse(a.at) < rule.limit.window_days * DAY).length >= rule.limit.max_attempts_per_window ||
          prior.some(a => a.triggered && Date.parse(current.at) - Date.parse(a.at) < rule.limit.cooldown_days * DAY)) {
        throw new Error(`Opportunity limit violated: ${id}`);
      }
    }
    if (world.encounters.some(e => e.source !== 'system_simulated' || e.status !== 'pending_choice') ||
        world.encounters.length !== world.attempts.filter(a => a.triggered).length) {
      throw new Error(`Unexpected encounter outcome: ${id}`);
    }
    const final = world.character.mathAnalysis;
    minSkill = Math.min(minSkill, final); maxSkill = Math.max(maxSkill, final); sumSkill += final;
    reachedSkill += Number(final >= 65);
    reachedSessions += Number(world.character.researchSessions >= 20);
    reachedLinks += Number(world.character.crossDomainLinks >= 3);
    eligibleCharacters += Number(hadEligibleEvent);
    attempts += world.attempts.length; leads += world.encounters.length;
    if (world.encounters.length === 0) distribution.zero++;
    else if (world.encounters.length === 1) distribution.one++;
    else distribution.twoOrMore++;
    const cohort = association < .525 ? lowAssociation : highAssociation;
    cohort.characters++; cohort.attempts += world.attempts.length;
    cohort.leads += world.encounters.length; cohort.withLead += Number(world.encounters.length > 0);
  }
  if (eligibleEvents !== attempts + suppressedEvents || distribution.zero + distribution.one + distribution.twoOrMore !== COUNT) {
    throw new Error('Simulation accounting invariant failed');
  }
  const formatGroup = (g: Group) => ({ ...g, fractionWithLead: round(g.withLead / g.characters) });
  return {
    scenario, syntheticCharacters: COUNT, daysPerCharacter: DAYS, minutesPerDay: 90,
    inputEvents: COUNT * DAYS,
    finalSkill: { mean: round(sumSkill / COUNT), min: round(minSkill), max: round(maxSkill) },
    reachedThresholds: { skill65: reachedSkill, researchSessions20: reachedSessions, crossDomainLinks3: reachedLinks, allConditionsAtLeastOnce: eligibleCharacters },
    eligibleEvents, attempts, suppressedByLimits: suppressedEvents, leads,
    leadDistribution: distribution,
    initialAssociationCohorts: { below0_525: formatGroup(lowAssociation), atLeast0_525: formatGroup(highAssociation) }
  };
}

const args = process.argv.slice(2);
if (args.length > 2 || (args.length > 0 && (args[0] !== '--seed' || !args[1]))) {
  throw new Error('Usage: npm run simulate -- [--seed <non-empty-seed>]');
}
const seed = args[1] ?? 'earth-online-v1';
const started = performance.now();
const mixed = simulate(seed, 'mixed');
const noCrossDomain = simulate(seed, 'no_cross_domain');
console.log(JSON.stringify({
  note: 'Synthetic game experiment only; generated inputs and research leads are not real-world evidence or predictions.',
  seed, rule: `${rule.id}@${rule.version}`,
  scenarios: {
    mixed: { script: '90 min daily; cross-domain every 4th day, otherwise review every 5th day, otherwise problem-solving', ...mixed },
    noCrossDomain: { script: '90 min daily; review every 5th day, otherwise problem-solving', ...noCrossDomain }
  }
}, null, 2));
// Runtime is diagnostic and intentionally excluded from reproducible JSON output.
console.error(`Simulation runtime: ${((performance.now() - started) / 1000).toFixed(2)} s (both scenarios)`);

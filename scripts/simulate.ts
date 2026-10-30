/** Offline synthetic-world test: NOT a prediction of real people. */
import { readFileSync } from 'node:fs';
import { createWorld, processEvent, type Rule, type StudyEvent, type Roll } from '../src/engine.ts';

const rule = JSON.parse(readFileSync(new URL('../examples/rules/math-insight.json', import.meta.url), 'utf8')) as Rule;

// Deterministic simulation-only hash; NOT secret or suitable for production rewards.
const hash32 = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
};
const roll: Roll = key => hash32(`offline-v1|${key}`) / 0x1_0000_0000;

function simulate(count = 1000, days = 120) {
  let totalAttempts = 0;
  let totalLeads = 0;
  let minSkill = Number.POSITIVE_INFINITY;
  let maxSkill = Number.NEGATIVE_INFINITY;
  let finalSkillSum = 0;
  let participants = 0;
  const start = Date.UTC(2026, 0, 2, 10);
  for (let person = 0; person < count; person++) {
    const id = `sim-${person}`;
    const initialSkill = 25 + (hash32(`initial|${person}`) % 1500) / 100;
    const adaptation = .15 + (hash32(`adapt|${person}`) % 7500) / 10000;
    const association = .15 + (hash32(`assoc|${person}`) % 7500) / 10000;
    let world = createWorld(id, initialSkill, adaptation, association);
    for (let day = 0; day < days; day++) {
      const method = day % 4 === 0 ? 'cross_domain' : day % 5 === 0 ? 'review' : 'problem_solving';
      const event: StudyEvent = {
        id: `${id}-day-${day}`,
        actorId: id,
        type: 'study.completed',
        source: 'self_reported',
        occurredAt: new Date(start + day * 86_400_000).toISOString(),
        durationMinutes: 90,
        idempotencyKey: `${id}-study-${day}`,
        payload: {subject:'math_analysis', method}
      };
      world = processEvent(world, event, [rule], roll).world;
    }
    const final = world.character.mathAnalysis;
    totalAttempts += world.attempts.length;
    totalLeads += world.encounters.length;
    if (world.encounters.length > 0) participants++;
    finalSkillSum += final;
    minSkill = Math.min(minSkill, final);
    maxSkill = Math.max(maxSkill, final);
  }
  return { syntheticCharacters: count, simulatedDaysEach: days,
    inputEvents: count * days, ruleAttempts: totalAttempts, researchLeads: totalLeads,
    charactersWithLead: participants, averageMathSkill: Number((finalSkillSum / count).toFixed(2)),
    minMathSkill: Number(minSkill.toFixed(2)), maxMathSkill: Number(maxSkill.toFixed(2)) };
}

const summary = simulate();
if (summary.inputEvents !== 120_000 || summary.ruleAttempts < 1 || summary.maxMathSkill <= summary.minMathSkill) {
  throw new Error(`Simulation invariant failed: ${JSON.stringify(summary)}`);
}
console.log(JSON.stringify(summary, null, 2));

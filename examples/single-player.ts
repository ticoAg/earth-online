/** A deterministic, fictional offline example; none of the events are real. */
import { readFileSync } from 'node:fs';
import { createWorld, processEvent, resolveEncounter, type Rule, type StudyEvent } from '../src/engine.ts';
import { getPublicCharacter } from '../src/projection.ts';

const rule = JSON.parse(readFileSync(new URL('./rules/math-insight.json', import.meta.url), 'utf8')) as Rule;
const initial = createWorld('example-player', 75, .6, .6);
// Start with fictional prior progress so the example can demonstrate the existing rule immediately.
let world = { ...initial, character: { ...initial.character, researchSessions: 25, crossDomainLinks: 5 } };
for (let day = 2; day <= 4; day++) {
  const event: StudyEvent = {
    id: `study-${day}`, actorId: 'example-player', type: 'study.completed', source: 'self_reported',
    occurredAt: `2026-01-0${day}T10:00:00.000Z`, durationMinutes: 90,
    idempotencyKey: `study-request-${day}`, payload: { subject: 'math_analysis', method: 'cross_domain' }
  };
  world = processEvent(world, event, [rule], () => 0).world;
  if (day === 2) {
    world = resolveEncounter(world, {
      id: 'choice-1', actorId: 'example-player', encounterId: world.encounters[0]!.id,
      choice: 'continue_research', occurredAt: '2026-01-02T11:30:00.000Z', idempotencyKey: 'choice-request-1'
    }).world;
  }
}
console.log(JSON.stringify(getPublicCharacter(world), null, 2));

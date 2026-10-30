/** Usage: npm run db:seed; npm run db:demo. Local synthetic fixtures ONLY. */
import { readFileSync } from 'node:fs';
import { openLocalDatabase } from './local-sqlite.ts';
import { loadWorld, seedSyntheticCharacters, submitPersistedEvent } from '../src/db/repository.ts';
import type { Rule, StudyEvent } from '../src/engine.ts';

const command = process.argv[2] ?? 'seed';
if (!['migrate', 'seed', 'demo'].includes(command)) throw new Error('Usage: db.ts [migrate|seed|demo]');
const db = openLocalDatabase(process.env.EARTH_DB_PATH ?? '.data/earth-online.sqlite');
try {
  db.migrate();
  if (command === 'migrate') console.log('SQLite migration applied');
  if (command === 'seed' || command === 'demo') {
    console.log(`New synthetic characters: ${await seedSyntheticCharacters(db)}`);
  }
  if (command === 'demo') {
    const rule = JSON.parse(readFileSync(new URL('../examples/rules/math-insight.json', import.meta.url), 'utf8')) as Rule;
    const event: StudyEvent = {
      id: 'demo-math-1', actorId: 'synthetic-0000', type: 'study.completed',
      source: 'self_reported', occurredAt: '2026-01-03T12:00:00.000Z',
      durationMinutes: 90, idempotencyKey: 'demo-request-1',
      payload: { subject: 'math_analysis', method: 'problem_solving' }
    };
    const result = await submitPersistedEvent(db, event, [rule], () => 0.99);
    const saved = await loadWorld(db, event.actorId);
    console.log(JSON.stringify({ result, persisted: saved?.character, events: saved?.accepted.length }, null, 2));
  }
} finally { db.close(); }

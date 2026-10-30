import { createWorld, processEvent, type World, type StudyEvent, type Rule, type Roll, type EventResult, type RuleAttempt, type Encounter } from '../engine.ts';

/** The subset of Cloudflare D1's prepared-statement API needed by this prototype. */
export type SqlValue = string | number | null;
export interface SqlStatement { bind(...values: SqlValue[]): SqlStatement }
export interface SqlResult { results: Record<string, unknown>[]; meta?: { changes?: number } }
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}

const statement = (db: SqlDatabase, sql: string, ...values: SqlValue[]): SqlStatement => db.prepare(sql).bind(...values);
const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('invalid_database_row');
  return value;
};
interface Snapshot { world: World; revision: string }

async function loadSnapshot(db: SqlDatabase, characterId: string): Promise<Snapshot | null> {
  const [characters, events, attempts, encounters] = await db.batch([
    statement(db, 'SELECT state_json, revision_token FROM characters WHERE id = ?', characterId),
    statement(db, 'SELECT idempotency_key, event_json, result_json FROM player_events WHERE character_id = ? ORDER BY occurred_at, id', characterId),
    statement(db, `SELECT a.attempt_json FROM rule_attempts a JOIN player_events e ON e.id = a.event_id
       WHERE a.character_id = ? ORDER BY e.occurred_at, e.id, a.rule_id, a.rule_version`, characterId),
    statement(db, `SELECT c.encounter_json FROM encounters c JOIN player_events e ON e.id = c.source_event_id
       WHERE c.character_id = ? ORDER BY e.occurred_at, e.id, c.id`, characterId)
  ]);
  const row = characters?.results[0];
  if (!row) return null;
  const accepted: StudyEvent[] = [];
  const idempotency: Record<string, EventResult> = Object.create(null) as Record<string, EventResult>;
  for (const event of events?.results ?? []) {
    const key = asString(event.idempotency_key);
    accepted.push(JSON.parse(asString(event.event_json)) as StudyEvent);
    Object.defineProperty(idempotency, key, { value: JSON.parse(asString(event.result_json)) as EventResult,
      enumerable: true, configurable: true, writable: true });
  }
  return {
    revision: asString(row.revision_token),
    world: {
      character: JSON.parse(asString(row.state_json)) as World['character'],
      accepted,
      idempotency,
      attempts: (attempts?.results ?? []).map(r => JSON.parse(asString(r.attempt_json)) as RuleAttempt),
      encounters: (encounters?.results ?? []).map(r => JSON.parse(asString(r.encounter_json)) as Encounter)
    }
  };
}

/** Create only a synthetic/test character for the initial prototype. Auth is not implemented. */
export async function insertCharacter(db: SqlDatabase, world: World): Promise<void> {
  if (world.accepted.length || world.attempts.length || world.encounters.length || Object.keys(world.idempotency).length) {
    throw new Error('insert_requires_fresh_world');
  }
  await db.batch([statement(db, 'INSERT INTO characters (id, state_json, revision_token) VALUES (?, ?, ?)',
    world.character.id, JSON.stringify(world.character), crypto.randomUUID())]);
}

export async function loadWorld(db: SqlDatabase, characterId: string): Promise<World | null> {
  const value = await loadSnapshot(db, characterId);
  return value?.world ?? null;
}

/**
 * Uses a single atomic D1 batch (or SQLite BEGIN IMMEDIATE) with optimistic CAS.
 * Every dependent write is gated on a fresh UUID revision; failed CAS writes nothing.
 * Pure game rules are reused unchanged from engine.ts.
 */
export async function submitPersistedEvent(
  db: SqlDatabase, event: StudyEvent, rules: Rule[], roll?: Roll
): Promise<EventResult> {
  for (let retry = 0; retry < 5; retry++) {
    const snapshot = await loadSnapshot(db, event.actorId);
    if (!snapshot) throw new Error('character_not_found');
    const { world: next, result } = processEvent(snapshot.world, event, rules, roll);
    // An identical accepted submission returns its original result, with no new RNG or write.
    if (snapshot.world.accepted.some(item => item.idempotencyKey === event.idempotencyKey)) return result;
    const revision = crypto.randomUUID();
    const statements: SqlStatement[] = [
      statement(db, `UPDATE characters SET state_json = ?, revision_token = ?
        WHERE id = ? AND revision_token = ?`,
        JSON.stringify(next.character), revision, event.actorId, snapshot.revision),
      statement(db, `INSERT INTO player_events (id, character_id, idempotency_key, event_json, result_json, occurred_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM characters WHERE id = ? AND revision_token = ?)`,
        event.id, event.actorId, event.idempotencyKey, JSON.stringify(event),
        JSON.stringify(result), event.occurredAt, event.actorId, revision)
    ];
    for (const a of next.attempts.slice(snapshot.world.attempts.length)) {
      statements.push(statement(db, `INSERT INTO rule_attempts
        (event_id, rule_id, rule_version, character_id, attempt_json)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM characters WHERE id = ? AND revision_token = ?)`,
        a.eventId, a.ruleId, a.version, event.actorId, JSON.stringify(a), event.actorId, revision));
    }
    for (const encounter of next.encounters.slice(snapshot.world.encounters.length)) {
      statements.push(statement(db, `INSERT INTO encounters (id, character_id, source_event_id, encounter_json)
        SELECT ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM characters WHERE id = ? AND revision_token = ?)`,
        encounter.id, event.actorId, encounter.sourceEventId,
        JSON.stringify(encounter), event.actorId, revision));
    }
    const writes = await db.batch(statements);
    if (writes[0]?.meta?.changes === 1) return result;
    // Concurrent writer updated the revision between our read and batch; recalculate.
  }
  throw new Error('concurrent_update_retry_exhausted');
}

/** Stable deterministic seed data. Never populate a production D1 binding with this function. */
export async function seedSyntheticCharacters(db: SqlDatabase, count = 1000): Promise<number> {
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('invalid_seed_count');
  let created = 0;
  // Avoid requiring an npm dependency or nonportable database features.
  for (let i = 0; i < count; i++) {
    const id = `synthetic-${String(i).padStart(4, '0')}`;
    const initial = 25 + ((i * 47) % 151) / 10;
    const adaptation = 0.15 + ((i * 71) % 751) / 1000;
    const association = 0.15 + ((i * 89) % 751) / 1000;
    const character = createWorld(id, initial, adaptation, association);
    const result = await db.batch([statement(db,
      'INSERT OR IGNORE INTO characters (id, state_json, revision_token) VALUES (?, ?, ?)',
      id, JSON.stringify(character.character), `seed-rev-${i}`)]);
    created += result[0]?.meta?.changes ?? 0;
  }
  return created;
}

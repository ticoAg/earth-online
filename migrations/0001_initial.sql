-- Earth Online v0.2: shared SQLite / Cloudflare D1 schema
-- All data in this prototype is game state, not medical or real-life prediction.
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  revision_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS player_events (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (character_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_player_events_character_time
  ON player_events(character_id, occurred_at, id);
CREATE TABLE IF NOT EXISTS rule_attempts (
  event_id TEXT NOT NULL REFERENCES player_events(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  attempt_json TEXT NOT NULL,
  PRIMARY KEY (event_id, rule_id, rule_version)
);
CREATE INDEX IF NOT EXISTS idx_rule_attempts_character ON rule_attempts(character_id);
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL REFERENCES player_events(id) ON DELETE CASCADE,
  encounter_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_encounters_character ON encounters(character_id);

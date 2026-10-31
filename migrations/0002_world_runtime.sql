-- World runtime: SQLite and Cloudflare D1-compatible SQL.
-- Players can be absent; scheduled world ticks are persisted independently.
CREATE TABLE IF NOT EXISTS world_runtime (
  world_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('STOPPED','RUNNING','PAUSED','MAINTENANCE')),
  epoch_ms INTEGER,
  pause_started_ms INTEGER,
  tick_duration_ms INTEGER NOT NULL CHECK(tick_duration_ms > 0),
  last_committed_tick INTEGER NOT NULL DEFAULT 0 CHECK(last_committed_tick >= 0),
  active_rule_version INTEGER NOT NULL DEFAULT 1,
  resources INTEGER NOT NULL DEFAULT 0 CHECK(resources BETWEEN 0 AND 1000),
  revision_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS world_rule_sets (
  world_id TEXT NOT NULL REFERENCES world_runtime(world_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  effective_tick INTEGER NOT NULL CHECK(effective_tick > 0),
  season_length_ticks INTEGER NOT NULL CHECK(season_length_ticks > 0),
  resource_per_tick INTEGER NOT NULL,
  festival_every_ticks INTEGER NOT NULL CHECK(festival_every_ticks > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (world_id, version),
  UNIQUE (world_id, effective_tick)
);
CREATE INDEX IF NOT EXISTS idx_world_rule_effective ON world_rule_sets(world_id, effective_tick);
CREATE TABLE IF NOT EXISTS world_ticks (
  world_id TEXT NOT NULL REFERENCES world_runtime(world_id) ON DELETE CASCADE,
  tick_index INTEGER NOT NULL CHECK(tick_index > 0),
  rule_version INTEGER NOT NULL,
  season TEXT NOT NULL,
  resources_after INTEGER NOT NULL,
  PRIMARY KEY (world_id, tick_index),
  FOREIGN KEY (world_id, rule_version) REFERENCES world_rule_sets(world_id, version)
);
CREATE TABLE IF NOT EXISTS world_events (
  world_id TEXT NOT NULL REFERENCES world_runtime(world_id) ON DELETE CASCADE,
  tick_index INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (world_id, tick_index, event_key),
  FOREIGN KEY (world_id, tick_index) REFERENCES world_ticks(world_id, tick_index)
);
CREATE INDEX IF NOT EXISTS idx_world_events_recent ON world_events(world_id, tick_index DESC);

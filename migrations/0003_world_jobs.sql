-- Deferred public events. Claims and effects commit with their world tick.
CREATE TABLE IF NOT EXISTS world_jobs (
  world_id TEXT NOT NULL REFERENCES world_runtime(world_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  due_tick INTEGER NOT NULL CHECK(due_tick > 0),
  next_attempt_tick INTEGER NOT NULL CHECK(next_attempt_tick >= due_tick),
  event_type TEXT NOT NULL CHECK(event_type IN ('world.research_activity','world.research_report')),
  payload_json TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  source_tick INTEGER,
  source_event_key TEXT,
  root_key TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 3),
  last_error TEXT,
  completed_tick INTEGER,
  PRIMARY KEY(world_id,idempotency_key),
  FOREIGN KEY(world_id,rule_version) REFERENCES world_rule_sets(world_id,version),
  FOREIGN KEY(world_id,source_tick,source_event_key) REFERENCES world_events(world_id,tick_index,event_key),
  CHECK((source_tick IS NULL) = (source_event_key IS NULL)),
  CHECK(attempts <= max_attempts)
);
CREATE INDEX IF NOT EXISTS idx_world_jobs_due ON world_jobs(world_id,status,next_attempt_tick,due_tick,idempotency_key);

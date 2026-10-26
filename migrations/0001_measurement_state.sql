CREATE TABLE tool_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  frozen INTEGER NOT NULL DEFAULT 1,
  frozen_at INTEGER NOT NULL DEFAULT 0,
  probe_cursor INTEGER NOT NULL DEFAULT 0,
  last_probe_slot INTEGER NOT NULL DEFAULT -1,
  probe_lease_until INTEGER NOT NULL DEFAULT 0,
  sync_lease_until INTEGER NOT NULL DEFAULT 0,
  backoff_until INTEGER NOT NULL DEFAULT 0,
  priority_line TEXT,
  priority_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO tool_control(id) VALUES (1);
CREATE TABLE line_state (
  line TEXT PRIMARY KEY CHECK (line IN ('CT','CU','CM','DEFAULT')),
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE probe_rounds (
  id TEXT PRIMARY KEY,
  line TEXT NOT NULL,
  baseline_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  reserved_tests INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX probe_rounds_line_time ON probe_rounds(line, started_at DESC);
CREATE TABLE switch_history (
  id TEXT PRIMARY KEY,
  line TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX switch_history_time ON switch_history(at);

-- T1 schema. Conceptual model: the T1 spec's data model section.
-- Times are ISO 8601 UTC text. IDs are text.

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  research_goal TEXT NOT NULL,
  -- Schedule preset: every_n_hours (interval_hours), daily (time_utc), weekly (weekday 0-6 = Sun-Sat, time_utc).
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('every_n_hours', 'daily', 'weekly')),
  schedule_interval_hours INTEGER CHECK (schedule_interval_hours IS NULL OR schedule_interval_hours BETWEEN 1 AND 168),
  schedule_weekday INTEGER CHECK (schedule_weekday IS NULL OR schedule_weekday BETWEEN 0 AND 6),
  schedule_time_utc TEXT CHECK (schedule_time_utc IS NULL OR schedule_time_utc GLOB '[0-2][0-9]:[0-5][0-9]'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  kind TEXT NOT NULL CHECK (kind IN ('feed')),
  format TEXT NOT NULL CHECK (format IN ('rss2', 'atom', 'hf_daily_papers')),
  fixture_ref TEXT,
  first_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX sources_topic ON sources(topic_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, -- equals the Workflow instance ID
  topic_id TEXT NOT NULL REFERENCES topics(id),
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual', 'replay')),
  scheduled_slot TEXT,
  source_run_id TEXT REFERENCES runs(id),
  from_stage TEXT CHECK (from_stage IS NULL OR from_stage IN ('triage', 'synthesis')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed_with_report', 'completed_no_new_findings', 'failed')),
  failed_stage TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  config_snapshot TEXT,
  config_hash TEXT,
  prompt_hashes TEXT,
  -- A scheduled Run always has a slot, so runs_topic_slot can enforce one Run per Topic and slot.
  CHECK (kind != 'scheduled' OR scheduled_slot IS NOT NULL)
);
CREATE INDEX runs_topic_created ON runs(topic_id, created_at);
CREATE UNIQUE INDEX runs_topic_slot ON runs(topic_id, scheduled_slot) WHERE kind = 'scheduled';

CREATE TABLE items (
  source_id TEXT NOT NULL REFERENCES sources(id),
  item_key TEXT NOT NULL, -- normalized Item identity
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  first_seen_run_id TEXT NOT NULL REFERENCES runs(id),
  content_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (source_id, item_key)
);

CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs(id),
  step TEXT NOT NULL CHECK (step IN ('fetch', 'dedupe', 'triage', 'synthesis', 'publish')),
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  artifact_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (run_id, step)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  published_at TEXT NOT NULL,
  public INTEGER NOT NULL CHECK (public IN (0, 1)),
  r2_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  finding_count INTEGER NOT NULL
);
CREATE INDEX reports_public_published ON reports(public, published_at);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id),
  title TEXT NOT NULL,
  what_is_new TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX findings_report ON findings(report_id, position);

CREATE TABLE finding_items (
  finding_id TEXT NOT NULL REFERENCES findings(id),
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  PRIMARY KEY (finding_id, source_id, item_key),
  FOREIGN KEY (source_id, item_key) REFERENCES items(source_id, item_key)
);

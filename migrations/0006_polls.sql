-- One Poll per Run and Source: the outcome of reading the Source's feed in that Run.
-- `fetch` writes every Poll; `dedupe` fills `items_new` and `items_filtered`, which stay NULL
-- when the Run never counted them (it failed at `fetch` or `dedupe`, or the Poll failed).
CREATE TABLE polls (
  run_id TEXT NOT NULL REFERENCES runs(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  items_read INTEGER NOT NULL CHECK (items_read >= 0),
  items_new INTEGER CHECK (items_new IS NULL OR items_new >= 0),
  items_filtered INTEGER CHECK (items_filtered IS NULL OR items_filtered >= 0),
  failure_reason TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (run_id, source_id),
  -- A failed Poll always says why; a succeeded one never carries a reason.
  CHECK ((outcome = 'failed') = (failure_reason IS NOT NULL))
);
CREATE INDEX polls_source_created ON polls(source_id, created_at);

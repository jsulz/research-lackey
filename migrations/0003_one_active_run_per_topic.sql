-- At most one active (queued or running) scheduled or manual Run per Topic, whoever inserts it.
-- Replay Runs are local experiments and are not limited.
CREATE UNIQUE INDEX runs_one_active_per_topic ON runs(topic_id)
  WHERE kind IN ('scheduled', 'manual') AND status IN ('queued', 'running');

-- Fixture feed Sources for the seed Topic (T1). Each reads a file bundled from fixtures/feeds/.
-- Real HTTP fetching replaces fixtures in T3.
INSERT INTO sources (id, topic_id, kind, format, fixture_ref) VALUES
  ('vllm-blog', 'ai-infra', 'feed', 'rss2', 'vllm-blog.rss.xml'),
  ('modal-blog', 'ai-infra', 'feed', 'atom', 'modal-blog.atom.xml'),
  ('arxiv-serving', 'ai-infra', 'feed', 'atom', 'arxiv-serving.atom.xml'),
  ('hf-daily-papers', 'ai-infra', 'feed', 'hf_daily_papers', 'hf-daily-papers-2026-11-13.json'),
  ('vllm-releases', 'ai-infra', 'feed', 'atom', 'vllm-releases.atom.xml');

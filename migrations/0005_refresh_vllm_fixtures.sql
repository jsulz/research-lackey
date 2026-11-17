-- Fresh captures of the two vLLM feeds (2026-11-17), so the daily Run has new Items to report:
-- the v0.34.0 release and one blog post. Earlier fixture files stay for tests.
UPDATE sources SET fixture_ref = 'vllm-blog-2026-11-17.rss.xml' WHERE id = 'vllm-blog';
UPDATE sources SET fixture_ref = 'vllm-releases-2026-11-17.atom.xml' WHERE id = 'vllm-releases';

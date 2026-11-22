-- The eight remaining starter Sources for the seed Topic (T2 wave 2), read over HTTP like the
-- first five. Keyword lists take their default, an empty list. Each Source's first Poll passes at
-- most the first-poll cap of Items to Triage and records the rest as seen.
INSERT INTO sources (id, topic_id, kind, format, url, exclude_title_pattern) VALUES
  -- arXiv API, newest 50 by submission date: training and fine-tuning systems in cs.DC.
  ('arxiv-training', 'ai-infra', 'feed', 'atom',
   'https://export.arxiv.org/api/query?search_query=cat:cs.DC+AND+%28abs:%22distributed+training%22+OR+abs:%22pipeline+parallelism%22+OR+abs:%22tensor+parallelism%22+OR+abs:%22mixture+of+experts%22+OR+abs:%22GPU+cluster%22+OR+abs:%22fine-tuning%22%29&sortBy=submittedDate&sortOrder=descending&max_results=50',
   NULL),
  ('pytorch-blog', 'ai-infra', 'feed', 'rss2', 'https://pytorch.org/feed/', NULL),
  ('nvidia-inference', 'ai-infra', 'feed', 'atom',
   'https://developer.nvidia.com/blog/tag/inference-performance/feed/', NULL),
  ('cloudflare-workers-ai', 'ai-infra', 'feed', 'rss2',
   'https://blog.cloudflare.com/tag/workers-ai/rss/', NULL),
  ('together-blog', 'ai-infra', 'feed', 'rss2', 'https://www.together.ai/blog/rss.xml', NULL),
  ('google-cloud-ai-infra', 'ai-infra', 'feed', 'rss2',
   'https://cloudblog.withgoogle.com/topics/ai-infrastructure/rss/', NULL),
  -- GitHub lists release candidates beside releases: the pattern removes them, as for
  -- `vllm-releases`, and allows a component prefix (`router-v0.1.0`) and a dot before `rc`.
  ('sglang-releases', 'ai-infra', 'feed', 'atom',
   'https://github.com/sgl-project/sglang/releases.atom',
   '^([a-z]+-)?v?\d+(\.\d+)*[-.]?rc\.?\d*\b'),
  ('semianalysis', 'ai-infra', 'feed', 'rss2', 'https://newsletter.semianalysis.com/feed', NULL);

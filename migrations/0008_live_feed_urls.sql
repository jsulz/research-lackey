-- Live feeds for the five seeded Sources (T2 wave 1). `fetch` requests `url` over HTTP; `{date}`
-- in it stands for the UTC day before the Run started. `fixture_ref` stays, but nothing reads it.
ALTER TABLE sources ADD COLUMN url TEXT;

-- arXiv API, newest 50 by submission date: LLM serving terms in the systems categories.
UPDATE sources SET url = 'https://export.arxiv.org/api/query?search_query=%28cat:cs.DC+OR+cat:cs.PF+OR+cat:cs.OS%29+AND+%28abs:%22LLM+serving%22+OR+abs:%22LLM+inference%22+OR+abs:%22KV+cache%22+OR+abs:%22speculative+decoding%22+OR+abs:%22inference+serving%22%29&sortBy=submittedDate&sortOrder=descending&max_results=50'
  WHERE id = 'arxiv-serving';

-- One complete day of papers, most outside the Topic: keep those that name an infrastructure term.
-- A starting list, to tune from the Polls' `items_filtered` counts.
UPDATE sources SET
  url = 'https://huggingface.co/api/daily_papers?date={date}',
  include_keywords = '["inference","serving","KV cache","training","distributed","GPU","kernel","quantization","mixture of experts","throughput","latency","cluster","parallelism","storage","checkpoint","compiler"]'
  WHERE id = 'hf-daily-papers';

UPDATE sources SET url = 'https://modal.com/blog/atom.xml' WHERE id = 'modal-blog';
UPDATE sources SET url = 'https://vllm.ai/blog/rss.xml' WHERE id = 'vllm-blog';

-- GitHub lists release candidates (`v0.34.0rc1`) beside releases: the pattern removes them.
UPDATE sources SET
  url = 'https://github.com/vllm-project/vllm/releases.atom',
  exclude_title_pattern = '^v?\d+(\.\d+)*-?rc\.?\d*\b'
  WHERE id = 'vllm-releases';

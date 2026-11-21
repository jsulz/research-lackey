-- Per-Source filters, applied by `dedupe`. An Item the filters remove is still recorded as seen and
-- counted in its Poll's `items_filtered`; it is never passed to Triage.
-- Keyword lists are JSON arrays of strings; an empty include list passes every Item.
ALTER TABLE sources ADD COLUMN include_keywords TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(include_keywords) AND json_type(include_keywords) = 'array');
ALTER TABLE sources ADD COLUMN exclude_keywords TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(exclude_keywords) AND json_type(exclude_keywords) = 'array');
-- A regular expression tested against the title, ignoring case. NULL removes nothing.
ALTER TABLE sources ADD COLUMN exclude_title_pattern TEXT;

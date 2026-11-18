-- Discovery provenance and raw provider payloads.
ALTER TABLE prospects ADD COLUMN source TEXT NOT NULL DEFAULT 'geoapify';
ALTER TABLE prospects ADD COLUMN source_id TEXT;
ALTER TABLE prospects ADD COLUMN category TEXT;
ALTER TABLE prospects ADD COLUMN raw_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_prospects_source_id ON prospects (source_id);

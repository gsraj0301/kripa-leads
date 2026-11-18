-- Kripa Leads: initial schema.
-- Six tables only. JSON payloads are stored as TEXT; query helpers own (de)serialization.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  provisional INTEGER NOT NULL DEFAULT 1,
  provisional_reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  area_text TEXT NOT NULL,
  resolved_place_id TEXT,
  resolved_label TEXT,
  segment_ids_json TEXT NOT NULL,
  include_previously_delivered INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT NOT NULL,
  segments_snapshot_json TEXT NOT NULL,
  scoring_snapshot_json TEXT NOT NULL,
  scoring_config_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  counts_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  company_key TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postcode TEXT,
  latitude REAL,
  longitude REAL,
  fit_score INTEGER,
  fit_band TEXT,
  contactability_score INTEGER,
  contactability_band TEXT,
  tags_json TEXT NOT NULL DEFAULT '{}',
  facts_json TEXT NOT NULL DEFAULT '{}',
  score_explain_json TEXT NOT NULL DEFAULT '{}',
  needs_manual_contact_research INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  enrichment_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_run_company
  ON prospects (run_id, company_key);
CREATE INDEX IF NOT EXISTS idx_prospects_run_fit
  ON prospects (run_id, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_segment
  ON prospects (segment_id, status);

CREATE TABLE IF NOT EXISTS deliveries (
  company_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  first_run_id TEXT NOT NULL,
  first_delivered_at TEXT NOT NULL,
  last_delivered_at TEXT NOT NULL,
  export_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs (id) ON DELETE CASCADE,
  prospect_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type, created_at);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  row_count INTEGER NOT NULL,
  filename TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exports_run ON exports (run_id, created_at);

export interface SettingsRow {
  id: number;
  config_json: string;
  config_version: number;
  approved: number;
  provisional: number;
  provisional_reason: string | null;
  updated_at: string;
  updated_by: string;
}

export interface RunRow {
  id: string;
  area_text: string;
  resolved_place_id: string | null;
  resolved_label: string | null;
  segment_ids_json: string;
  include_previously_delivered: number;
  plan_json: string;
  segments_snapshot_json: string;
  scoring_snapshot_json: string;
  scoring_config_version: number;
  status: string;
  counts_json: string;
  created_at: string;
  updated_at: string;
}

export interface ProspectRow {
  id: string;
  run_id: string;
  segment_id: string;
  source: string;
  source_id: string | null;
  category: string | null;
  company_key: string;
  name: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  fit_score: number | null;
  fit_band: string | null;
  contactability_score: number | null;
  contactability_band: string | null;
  tags_json: string;
  facts_json: string;
  raw_json: string;
  score_explain_json: string;
  needs_manual_contact_research: number;
  provenance_json: string;
  enrichment_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  company_key: string;
  name: string;
  domain: string | null;
  first_run_id: string;
  first_delivered_at: string;
  last_delivered_at: string;
  export_count: number;
}

export interface EventRow {
  id: string;
  run_id: string | null;
  prospect_id: string | null;
  event_type: string;
  payload_json: string;
  actor_email: string | null;
  created_at: string;
}

export interface ExportRow {
  id: string;
  run_id: string;
  row_count: number;
  filename: string;
  filters_json: string;
  actor_email: string;
  created_at: string;
}

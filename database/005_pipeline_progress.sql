ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS discovery_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE qualifications ADD COLUMN IF NOT EXISTS ai_status text NOT NULL DEFAULT 'not_requested';
CREATE INDEX IF NOT EXISTS qualifications_ai_pending_idx ON qualifications(company_id) WHERE ai_status='pending';

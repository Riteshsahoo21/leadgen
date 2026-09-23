ALTER TABLE website_evidence
  ADD COLUMN IF NOT EXISTS phones text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS contact_sources jsonb NOT NULL DEFAULT '[]'::jsonb;

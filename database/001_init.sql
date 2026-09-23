CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  country text NOT NULL,
  cities text[] NOT NULL,
  business_types text[] NOT NULL,
  target_count integer NOT NULL CHECK (target_count BETWEEN 1 AND 50000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
  provider_mode text NOT NULL DEFAULT 'safe' CHECK (provider_mode IN ('safe','live')),
  stats jsonb NOT NULL DEFAULT '{"discovered":0,"filtered":0,"qualified":0,"contacts":0,"verified":0,"contacted":0}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  discovery_finished_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'google_maps',
  source_id text,
  name text NOT NULL,
  normalized_name text NOT NULL,
  category text,
  categories text[] NOT NULL DEFAULT '{}',
  country text NOT NULL,
  city text,
  address text,
  phone text,
  website text,
  domain text,
  rating numeric(3,2),
  review_count integer NOT NULL DEFAULT 0,
  latitude double precision,
  longitude double precision,
  status text NOT NULL DEFAULT 'discovered',
  filter_score integer,
  filter_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_run_source_id_unique
  ON companies(run_id, source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_run_domain_unique
  ON companies(run_id, domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_run_phone_unique
  ON companies(run_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_run_name_address_unique
  ON companies(run_id, normalized_name, address) WHERE address IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_run_status_idx ON companies(run_id, status);
CREATE INDEX IF NOT EXISTS companies_domain_idx ON companies(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_phone_idx ON companies(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_fallback_dedupe_idx ON companies(run_id, normalized_name, city);

CREATE TABLE IF NOT EXISTS website_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  title text,
  description text,
  about text,
  services text[] NOT NULL DEFAULT '{}',
  emails text[] NOT NULL DEFAULT '{}',
  social_links text[] NOT NULL DEFAULT '{}',
  technologies text[] NOT NULL DEFAULT '{}',
  has_contact_form boolean NOT NULL DEFAULT false,
  has_booking boolean NOT NULL DEFAULT false,
  has_payment boolean NOT NULL DEFAULT false,
  pages_crawled integer NOT NULL DEFAULT 0,
  used_browser boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  crawled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  qualified boolean NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  opportunity text NOT NULL,
  pain_points text[] NOT NULL DEFAULT '{}',
  recommended_role text NOT NULL DEFAULT 'Owner',
  rationale text,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  role text,
  source_url text,
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, full_name, role)
);

CREATE TABLE IF NOT EXISTS contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unknown' CHECK (verification_status IN ('valid','risky','catch_all','unknown','invalid')),
  verification_method text,
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, email)
);

CREATE TABLE IF NOT EXISTS suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_email_id uuid NOT NULL REFERENCES contact_emails(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  status text NOT NULL DEFAULT 'queued',
  provider_id text,
  subject text,
  body text,
  reply_category text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES discovery_runs(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  stage text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_events_run_created_idx ON pipeline_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_run_status_idx ON messages(run_id, status);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS discovery_runs_touch ON discovery_runs;
CREATE TRIGGER discovery_runs_touch BEFORE UPDATE ON discovery_runs
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS companies_touch ON companies;
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

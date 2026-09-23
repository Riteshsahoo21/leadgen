import pg from 'pg';
import { config } from './config.js';
import { normalizeDomain, normalizeName, type BusinessCandidate, type CreateRunInput } from './domain.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });

export async function closeDatabase() {
  await pool.end();
}

export async function databaseHealth() {
  const result = await pool.query<{ now: string }>('SELECT now()::text AS now');
  return result.rows[0]?.now;
}

export async function createRun(input: CreateRunInput) {
  const result = await pool.query(
    `INSERT INTO discovery_runs (name, country, cities, business_types, target_count, provider_mode)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.name, input.country, input.cities, input.businessTypes, input.targetCount, config.PROVIDER_MODE],
  );
  return result.rows[0];
}

export async function listRuns(limit = 30) {
  const result = await pool.query(
    `SELECT * FROM discovery_runs ORDER BY created_at DESC LIMIT $1`, [limit],
  );
  return result.rows;
}

export async function getRun(id: string) {
  const result = await pool.query('SELECT * FROM discovery_runs WHERE id = $1', [id]);
  return result.rows[0];
}

export async function setRunStatus(id: string, status: string, error?: string) {
  await pool.query(
    `UPDATE discovery_runs SET status = $2, error = $3,
       started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       completed_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE completed_at END
     WHERE id = $1`,
    [id, status, error ?? null],
  );
}

export async function markDiscoveryFinished(id: string) {
  await pool.query('UPDATE discovery_runs SET discovery_finished_at=now() WHERE id=$1', [id]);
}

const terminalCompanyStatuses = [
  'filtered_out', 'unqualified', 'no_contact', 'no_email', 'email_risky',
  'invalid_email', 'contact_found', 'email_verified', 'drafted', 'contacted', 'failed',
];

export async function maybeCompleteRun(runId: string) {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT discovery_finished_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM companies WHERE run_id=$1 AND NOT (status = ANY($2::text[]))
       ) AS ready
     FROM discovery_runs WHERE id=$1`,
    [runId, terminalCompanyStatuses],
  );
  if (result.rows[0]?.ready) {
    await refreshRunStats(runId);
    const updated = await pool.query(
      `UPDATE discovery_runs SET status='completed',completed_at=now()
       WHERE id=$1 AND status IN ('queued','running') RETURNING id`, [runId],
    );
    if (updated.rowCount) {
      await logEvent(runId, 'complete', 'Discovery run completed');
      return true;
    }
  }
  return false;
}

export async function insertCompany(runId: string, candidate: BusinessCandidate) {
  const domain = normalizeDomain(candidate.website);
  const values = [
    runId, candidate.sourceId ?? null, candidate.name, normalizeName(candidate.name), candidate.category ?? null,
    candidate.categories ?? [], candidate.country, candidate.city ?? null, candidate.address ?? null,
    candidate.phone ?? null, candidate.website ?? null, domain ?? null, candidate.rating ?? null,
    candidate.reviewCount ?? 0, candidate.latitude ?? null, candidate.longitude ?? null, candidate.raw ?? {},
  ];
  const result = await pool.query(
    `WITH inserted AS (
     INSERT INTO companies (
       run_id, source_id, name, normalized_name, category, categories, country, city, address,
       phone, website, domain, rating, review_count, latitude, longitude, raw_data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING
     RETURNING *)
     SELECT * FROM inserted
     UNION ALL
     SELECT * FROM companies
     WHERE run_id=$1 AND (
       ($2::text IS NOT NULL AND source='google_maps' AND source_id=$2) OR
       ($12::text IS NOT NULL AND domain=$12) OR
       ($10::text IS NOT NULL AND phone=$10) OR
       ($9::text IS NOT NULL AND normalized_name=$4 AND address=$9)
     )
     LIMIT 1`,
    values,
  );
  if (!result.rows[0]) throw new Error(`Could not insert or resolve company: ${candidate.name}`);
  return result.rows[0];
}

export async function getCompany(id: string) {
  const result = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
  return result.rows[0];
}

export async function updateCompanyFilter(id: string, score: number, reasons: string[], status: string) {
  await pool.query(
    'UPDATE companies SET filter_score = $2, filter_reasons = $3, status = $4 WHERE id = $1',
    [id, score, JSON.stringify(reasons), status],
  );
}

export async function updateCompanyStatus(id: string, status: string) {
  await pool.query('UPDATE companies SET status = $2 WHERE id = $1', [id, status]);
}

export async function saveEvidence(companyId: string, evidence: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO website_evidence (
       company_id,title,description,about,services,emails,social_links,technologies,
       has_contact_form,has_booking,has_payment,pages_crawled,used_browser,evidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (company_id) DO UPDATE SET
       title=EXCLUDED.title,description=EXCLUDED.description,about=EXCLUDED.about,
       services=EXCLUDED.services,emails=EXCLUDED.emails,social_links=EXCLUDED.social_links,
       technologies=EXCLUDED.technologies,has_contact_form=EXCLUDED.has_contact_form,
       has_booking=EXCLUDED.has_booking,has_payment=EXCLUDED.has_payment,
       pages_crawled=EXCLUDED.pages_crawled,used_browser=EXCLUDED.used_browser,
       evidence=EXCLUDED.evidence,crawled_at=now()`,
    [
      companyId, evidence.title ?? null, evidence.description ?? null, evidence.about ?? null,
      evidence.services ?? [], evidence.emails ?? [], evidence.socialLinks ?? [], evidence.technologies ?? [],
      evidence.hasContactForm ?? false, evidence.hasBooking ?? false, evidence.hasPayment ?? false,
      evidence.pagesCrawled ?? 0, evidence.usedBrowser ?? false, JSON.stringify(evidence),
    ],
  );
}

export async function getEvidence(companyId: string) {
  const result = await pool.query('SELECT * FROM website_evidence WHERE company_id = $1', [companyId]);
  return result.rows[0];
}

export async function saveQualification(companyId: string, value: {
  qualified: boolean; score: number; opportunity: string; painPoints: string[];
  recommendedRole: string; rationale?: string; model?: string;
}) {
  await pool.query(
    `INSERT INTO qualifications
       (company_id,qualified,score,opportunity,pain_points,recommended_role,rationale,model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id) DO UPDATE SET qualified=EXCLUDED.qualified,score=EXCLUDED.score,
       opportunity=EXCLUDED.opportunity,pain_points=EXCLUDED.pain_points,
       recommended_role=EXCLUDED.recommended_role,rationale=EXCLUDED.rationale,model=EXCLUDED.model`,
    [companyId, value.qualified, value.score, value.opportunity, value.painPoints,
      value.recommendedRole, value.rationale ?? null, value.model ?? null],
  );
}

export async function saveContact(companyId: string, contact: { fullName: string; role?: string | undefined; sourceUrl?: string | undefined; confidence: number }) {
  const result = await pool.query(
    `INSERT INTO contacts (company_id,full_name,role,source_url,confidence)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id,full_name,role) DO UPDATE SET
       source_url=EXCLUDED.source_url,confidence=GREATEST(contacts.confidence,EXCLUDED.confidence)
     RETURNING *`,
    [companyId, contact.fullName, contact.role ?? null, contact.sourceUrl ?? null, contact.confidence],
  );
  return result.rows[0];
}

export async function saveEmail(contactId: string, companyId: string, email: {
  address: string; status: string; method: string; confidence: number; evidence?: Record<string, unknown>;
}) {
  const result = await pool.query(
    `INSERT INTO contact_emails
       (contact_id,company_id,email,verification_status,verification_method,confidence,evidence,verified_at)
     VALUES ($1,$2,lower($3),$4,$5,$6,$7,now())
     ON CONFLICT (company_id,email) DO UPDATE SET verification_status=EXCLUDED.verification_status,
       verification_method=EXCLUDED.verification_method,confidence=EXCLUDED.confidence,
       evidence=EXCLUDED.evidence,verified_at=now()
     RETURNING *`,
    [contactId, companyId, email.address, email.status, email.method, email.confidence, email.evidence ?? {}],
  );
  return result.rows[0];
}

export async function logEvent(runId: string, stage: string, message: string, companyId?: string, payload: Record<string, unknown> = {}) {
  await pool.query(
    'INSERT INTO pipeline_events (run_id,company_id,stage,message,payload) VALUES ($1,$2,$3,$4,$5)',
    [runId, companyId ?? null, stage, message, payload],
  );
}

export async function refreshRunStats(runId: string) {
  await pool.query(
    `UPDATE discovery_runs r SET stats = jsonb_build_object(
       'discovered', (SELECT count(*) FROM companies c WHERE c.run_id=r.id),
       'filtered', (SELECT count(*) FROM companies c WHERE c.run_id=r.id AND c.status NOT IN ('discovered','filtered_out')),
       'qualified', (SELECT count(*) FROM companies c JOIN qualifications q ON q.company_id=c.id WHERE c.run_id=r.id AND q.qualified),
       'contacts', (SELECT count(*) FROM contacts x JOIN companies c ON c.id=x.company_id WHERE c.run_id=r.id),
       'verified', (SELECT count(*) FROM contact_emails e JOIN companies c ON c.id=e.company_id WHERE c.run_id=r.id AND e.verification_status='valid'),
       'contacted', (SELECT count(*) FROM messages m WHERE m.run_id=r.id AND m.direction='outbound' AND m.status IN ('sent','delivered'))
     ) WHERE r.id=$1`,
    [runId],
  );
}

export async function dashboardOverview() {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM companies) AS businesses,
      (SELECT count(*)::int FROM qualifications WHERE qualified) AS qualified,
      (SELECT count(*)::int FROM contact_emails WHERE verification_status='valid') AS verified,
      (SELECT count(*)::int FROM messages WHERE direction='outbound' AND status IN ('sent','delivered')) AS contacted,
      (SELECT count(*)::int FROM discovery_runs WHERE status IN ('queued','running')) AS active_runs
  `);
  return result.rows[0];
}

export async function recentLeads(limit = 20) {
  const result = await pool.query(
    `SELECT c.id,c.name,c.category,c.city,c.country,c.website,c.phone,c.status,c.filter_score,
       q.score AS qualification_score,q.opportunity,
       x.full_name,x.role,e.email,e.verification_status
     FROM companies c
     LEFT JOIN qualifications q ON q.company_id=c.id
     LEFT JOIN LATERAL (SELECT * FROM contacts WHERE company_id=c.id ORDER BY confidence DESC LIMIT 1) x ON true
     LEFT JOIN LATERAL (SELECT * FROM contact_emails WHERE company_id=c.id ORDER BY confidence DESC LIMIT 1) e ON true
     ORDER BY c.updated_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function recentEvents(limit = 30) {
  const result = await pool.query(
    `SELECT e.id,e.stage,e.level,e.message,e.created_at,r.name AS run_name,c.name AS company_name
     FROM pipeline_events e
     LEFT JOIN discovery_runs r ON r.id=e.run_id
     LEFT JOIN companies c ON c.id=e.company_id
     ORDER BY e.created_at DESC LIMIT $1`, [limit],
  );
  return result.rows;
}

export async function listBusinesses(input: { search?: string | undefined; status?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}) {
  const search = input.search?.trim() ?? '';
  const status = input.status?.trim() ?? '';
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const where = `WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR c.city ILIKE '%' || $1 || '%'
      OR c.country ILIKE '%' || $1 || '%' OR c.category ILIKE '%' || $1 || '%' OR c.domain ILIKE '%' || $1 || '%')
    AND ($2 = '' OR c.status = $2)`;
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT c.id,c.run_id,c.name,c.category,c.city,c.country,c.address,c.website,c.domain,c.phone,
         c.rating,c.review_count,c.status,c.filter_score,c.created_at,c.updated_at,
         q.qualified,q.score AS qualification_score,q.opportunity,q.pain_points,q.recommended_role,
         x.full_name,x.role,x.source_url,x.confidence AS contact_confidence,
         e.email,e.verification_status,e.confidence AS email_confidence
       FROM companies c
       LEFT JOIN qualifications q ON q.company_id=c.id
       LEFT JOIN LATERAL (SELECT * FROM contacts WHERE company_id=c.id ORDER BY confidence DESC LIMIT 1) x ON true
       LEFT JOIN LATERAL (SELECT * FROM contact_emails WHERE company_id=c.id ORDER BY confidence DESC LIMIT 1) e ON true
       ${where}
       ORDER BY c.updated_at DESC LIMIT $3 OFFSET $4`,
      [search, status, limit, offset],
    ),
    pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM companies c ${where}`, [search, status]),
  ]);
  return { items: items.rows, total: count.rows[0]?.count ?? 0, limit, offset };
}

export async function getBusinessDetail(id: string) {
  const result = await pool.query(
    `SELECT c.*,
       row_to_json(q) AS qualification,
       row_to_json(w) AS website_evidence,
       COALESCE((SELECT jsonb_agg(x ORDER BY x.confidence DESC) FROM contacts x WHERE x.company_id=c.id), '[]'::jsonb) AS contacts,
       COALESCE((SELECT jsonb_agg(e ORDER BY e.confidence DESC) FROM contact_emails e WHERE e.company_id=c.id), '[]'::jsonb) AS emails,
       COALESCE((SELECT jsonb_agg(m ORDER BY m.created_at DESC) FROM messages m WHERE m.company_id=c.id), '[]'::jsonb) AS messages
     FROM companies c
     LEFT JOIN qualifications q ON q.company_id=c.id
     LEFT JOIN website_evidence w ON w.company_id=c.id
     WHERE c.id=$1`,
    [id],
  );
  return result.rows[0];
}

export async function listQualifications(input: { qualified?: boolean | undefined; limit?: number | undefined } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const result = await pool.query(
    `SELECT q.*,c.name AS company_name,c.category,c.city,c.country,c.website,c.status
     FROM qualifications q JOIN companies c ON c.id=q.company_id
     WHERE ($1::boolean IS NULL OR q.qualified=$1)
     ORDER BY q.score DESC,q.created_at DESC LIMIT $2`,
    [input.qualified ?? null, limit],
  );
  return result.rows;
}

export async function listMessages(input: { direction?: string | undefined; limit?: number | undefined } = {}) {
  const direction = input.direction?.trim() ?? '';
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const result = await pool.query(
    `SELECT m.*,c.name AS company_name,e.email,x.full_name,x.role
     FROM messages m
     JOIN companies c ON c.id=m.company_id
     JOIN contact_emails e ON e.id=m.contact_email_id
     JOIN contacts x ON x.id=e.contact_id
     WHERE ($1='' OR m.direction=$1)
     ORDER BY m.created_at DESC LIMIT $2`,
    [direction, limit],
  );
  return result.rows;
}

export async function listPipelineEvents(limit = 100) {
  return recentEvents(Math.min(Math.max(limit, 1), 250));
}

export async function eligibleEmail(emailId: string) {
  const result = await pool.query(
    `SELECT e.*,c.run_id,c.name AS company_name,x.full_name,x.role,q.opportunity,q.pain_points
     FROM contact_emails e
     JOIN companies c ON c.id=e.company_id
     JOIN contacts x ON x.id=e.contact_id
     LEFT JOIN qualifications q ON q.company_id=c.id
     LEFT JOIN suppression_list s ON s.email=e.email
     WHERE e.id=$1 AND e.verification_status='valid' AND s.id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         JOIN contact_emails previous_email ON previous_email.id=m.contact_email_id
         WHERE previous_email.email=e.email AND m.direction='outbound'
       )`,
    [emailId],
  );
  return result.rows[0];
}

export async function createMessage(input: { runId: string; companyId: string; emailId: string; status: string; providerId?: string; subject: string; body: string }) {
  await pool.query(
    `INSERT INTO messages (run_id,company_id,contact_email_id,direction,status,provider_id,subject,body,sent_at)
     VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,CASE WHEN $4='sent' THEN now() ELSE NULL END)`,
    [input.runId, input.companyId, input.emailId, input.status, input.providerId ?? null, input.subject, input.body],
  );
}

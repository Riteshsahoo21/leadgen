export type RunStats = {
  discovered: number;
  filtered: number;
  qualified: number;
  contacts: number;
  verified: number;
  contacted: number;
};

export type Run = {
  id: string;
  name: string;
  country: string;
  cities: string[];
  business_types: string[];
  target_count: number;
  status: string;
  provider_mode: string;
  stats: RunStats;
  error?: string;
  created_at: string;
  updated_at?: string;
};

export type Lead = {
  id: string;
  run_id?: string;
  name: string;
  category?: string;
  city?: string;
  country: string;
  address?: string;
  website?: string;
  domain?: string;
  phone?: string;
  rating?: number;
  review_count?: number;
  status: string;
  filter_score?: number;
  filter_reasons?: string[];
  qualified?: boolean;
  qualification_score?: number;
  opportunity?: string;
  score_breakdown?: ScoreBreakdown;
  run_rank?: number;
  run_total?: number;
  top_percent?: number;
  pain_points?: string[];
  recommended_role?: string;
  full_name?: string;
  role?: string;
  source_url?: string;
  contact_confidence?: number;
  email?: string;
  verification_status?: string;
  email_confidence?: number;
  created_at?: string;
  updated_at?: string;
  raw_data?: Record<string, unknown>;
};

export type Qualification = {
  id: string;
  company_id: string;
  company_name: string;
  category?: string;
  city?: string;
  country: string;
  website?: string;
  status: string;
  qualified: boolean;
  score: number;
  opportunity: string;
  pain_points: string[];
  recommended_role: string;
  rationale?: string;
  model?: string;
  has_website: boolean;
  score_breakdown?: ScoreBreakdown;
  run_rank: number;
  run_total: number;
  top_percent: number;
  priority_label: string;
  contact_count: number;
  email_count: number;
  review_count: number;
  created_at: string;
};

export type ScoreBreakdown = {
  need?: number;
  businessStrength?: number;
  reachability?: number;
  evidenceQuality?: number;
  penalty?: number;
  total?: number;
  signals?: string[];
};

export type Message = {
  id: string;
  company_name: string;
  email: string;
  full_name: string;
  role?: string;
  direction: 'inbound' | 'outbound';
  status: string;
  subject?: string;
  body?: string;
  reply_category?: string;
  created_at: string;
};

export type QueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
};

export type EventItem = {
  id: number;
  stage: string;
  level: string;
  message: string;
  created_at: string;
  run_name?: string;
  company_name?: string;
};

export type OverviewResponse = {
  overview: { businesses: number; qualified: number; verified: number; contacted: number; active_runs: number };
  queues: Record<string, QueueCounts>;
  runs: Run[];
  leads: Lead[];
  events: EventItem[];
};

export type AppConfig = {
  providerMode: 'safe' | 'live';
  pipelineStopAfter: 'research' | 'enrichment' | 'draft';
  emailSending: boolean;
  dailySendLimit: number;
  maxDiscoveryResults: number;
  qualificationThreshold: number;
};

const tokenKey = 'leadforge-api-token';
export const getToken = () => localStorage.getItem(tokenKey) ?? '';
export const setToken = (value: string) => localStorage.setItem(tokenKey, value);
export const clearToken = () => localStorage.removeItem(tokenKey);

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}`, ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function queryString(values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

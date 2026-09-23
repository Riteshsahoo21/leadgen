export type RunStats = { discovered: number; filtered: number; qualified: number; contacts: number; verified: number; contacted: number };
export type Run = {
  id: string; name: string; country: string; cities: string[]; business_types: string[]; target_count: number;
  status: string; provider_mode: string; stats: RunStats; error?: string; created_at: string;
};
export type Lead = {
  id: string; name: string; category?: string; city?: string; country: string; website?: string; phone?: string;
  status: string; filter_score?: number; qualification_score?: number; opportunity?: string;
  full_name?: string; role?: string; email?: string; verification_status?: string;
};
export type QueueCounts = { waiting: number; active: number; completed: number; failed: number; delayed: number };
export type EventItem = { id: number; stage: string; level: string; message: string; created_at: string; run_name?: string; company_name?: string };
export type OverviewResponse = {
  overview: { businesses: number; qualified: number; verified: number; contacted: number; active_runs: number };
  queues: Record<string, QueueCounts>; runs: Run[]; leads: Lead[]; events: EventItem[];
};

const tokenKey = 'leadforge-api-token';
export const getToken = () => localStorage.getItem(tokenKey) ?? '';
export const setToken = (value: string) => localStorage.setItem(tokenKey, value);

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}`, ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  return body as T;
}

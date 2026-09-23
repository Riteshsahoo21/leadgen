import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, type OverviewResponse } from '../api';

const emptyOverview: OverviewResponse = {
  overview: { businesses: 0, qualified: 0, verified: 0, contacted: 0, active_runs: 0 },
  queues: {},
  runs: [],
  leads: [],
  events: [],
};

type DashboardValue = {
  data: OverviewResponse;
  authenticated: boolean;
  loading: boolean;
  error: string;
  refresh: (quiet?: boolean) => Promise<void>;
};

const DashboardContext = createContext<DashboardValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState(emptyOverview);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [error, setError] = useState('');

  const refresh = useCallback(async (quiet = false) => {
    if (!getToken()) {
      setAuthenticated(false);
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const next = await api<OverviewResponse>('/api/overview');
      setData(next);
      setAuthenticated(true);
      setError('');
    } catch (reason) {
      setAuthenticated(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <DashboardContext.Provider value={{ data, authenticated, loading, error, refresh }}>{children}</DashboardContext.Provider>;
}

export function useDashboard() {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('useDashboard must be used within DashboardProvider');
  return value;
}

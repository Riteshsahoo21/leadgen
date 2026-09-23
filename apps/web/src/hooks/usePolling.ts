import { useEffect, useRef } from 'react';

export function usePolling(task: () => Promise<void>, intervalMs = 5_000, refreshKey = '') {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    let disposed = false;
    let running = false;
    const tick = async () => {
      if (disposed || running || document.visibilityState === 'hidden') return;
      running = true;
      try { await taskRef.current(); } catch { /* pages keep their last successful snapshot */ } finally { running = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    const onVisibility = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, refreshKey]);
}

import { useEffect } from "react";

/**
 * Custom hook for auto-refreshing data at a specified interval
 * @param callback - Function to call on each refresh
 * @param isActive - Whether the auto-refresh should be active
 * @param intervalMs - Refresh interval in milliseconds
 * @param dependencies - Additional dependencies to trigger re-subscription
 */
export function useAutoRefresh(
  callback: () => void,
  isActive: boolean,
  intervalMs: number,
  dependencies: any[] = []
): void {
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      callback();
    }, intervalMs);

    return () => clearInterval(interval);
  }, [isActive, intervalMs, ...dependencies]);
}


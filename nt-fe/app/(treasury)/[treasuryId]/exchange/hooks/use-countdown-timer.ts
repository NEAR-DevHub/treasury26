import { useEffect, useState } from "react";

/**
 * Custom hook for countdown timer
 * @param isActive - Whether the timer should be active
 * @param intervalMs - Refresh interval in milliseconds
 * @returns Current seconds until refresh
 */
export function useCountdownTimer(
  isActive: boolean,
  intervalMs: number
): number {
  const [timeUntilRefresh, setTimeUntilRefresh] = useState(intervalMs / 1000);

  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      setTimeUntilRefresh((prev) => {
        if (prev <= 1) return intervalMs / 1000;
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, intervalMs]);

  // Reset timer when intervalMs changes
  useEffect(() => {
    setTimeUntilRefresh(intervalMs / 1000);
  }, [intervalMs]);

  return timeUntilRefresh;
}


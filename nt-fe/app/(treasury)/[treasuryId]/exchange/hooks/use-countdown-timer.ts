import { useEffect, useState, useRef } from "react";

/**
 * Custom hook for countdown timer using timestamps
 * @param isActive - Whether the timer should be active
 * @param intervalMs - Refresh interval in milliseconds
 * @param resetTrigger - Value that triggers timer reset when it changes
 * @returns Current seconds until refresh
 */
export function useCountdownTimer(
  isActive: boolean,
  intervalMs: number,
  resetTrigger?: any
): number {
  const [timeUntilRefresh, setTimeUntilRefresh] = useState(intervalMs / 1000);
  const startTimeRef = useRef<number>(Date.now());

  // Reset timer when resetTrigger or intervalMs changes
  useEffect(() => {
    startTimeRef.current = Date.now();
    setTimeUntilRefresh(intervalMs / 1000);
  }, [intervalMs, resetTrigger]);

  useEffect(() => {
    if (!isActive) return;

    // Calculate time remaining based on elapsed time since start
    const calculateTimeRemaining = () => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, intervalMs - elapsed);
      const remainingSeconds = Math.ceil(remaining / 1000);
      
      if (remainingSeconds <= 0) {
        // Reset for next cycle
        startTimeRef.current = Date.now();
        return intervalMs / 1000;
      }
      
      return remainingSeconds;
    };

    // Update immediately on mount/activation
    setTimeUntilRefresh(calculateTimeRemaining());

    // Then update every second
    const interval = setInterval(() => {
      setTimeUntilRefresh(calculateTimeRemaining());
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, intervalMs]);

  return timeUntilRefresh;
}


"use client";

import { useEffect, useState } from "react";

const TICK_MS = 30_000;

/**
 * Wall-clock ticker for deposit expiry countdowns.
 * Only runs while `enabled` and an expiry timestamp is present.
 */
export function useDepositExpiryClock(
    enabled: boolean,
    expiresAtMs: number | null | undefined,
): number {
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        if (!enabled || expiresAtMs == null) {
            return;
        }
        setNowMs(Date.now());
        const id = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
        return () => window.clearInterval(id);
    }, [enabled, expiresAtMs]);

    return nowMs;
}

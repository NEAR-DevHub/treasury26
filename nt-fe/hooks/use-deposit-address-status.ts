"use client";

import { useEffect, useState } from "react";
import {
    isDepositAddressExpired,
    isDepositAddressUsed,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-expires";
import {
    type DepositAddressStatusResponse,
    fetchDepositAddressStatus,
} from "@/lib/bridge-api";

const POLL_MS = 15_000;

export type DepositAddressStatusState = {
    hasFetched: boolean;
    found: boolean | null;
    status: string | null;
    expiresAtMs: number | null;
    originAsset: string | null;
    destinationAsset: string | null;
    /** True when used, expired, or history miss after a successful fetch. */
    isTerminal: boolean;
};

const IDLE: DepositAddressStatusState = {
    hasFetched: false,
    found: null,
    status: null,
    expiresAtMs: null,
    originAsset: null,
    destinationAsset: null,
    isTerminal: false,
};

function parseExpiresAtMs(result: DepositAddressStatusResponse): number | null {
    if (!result.expiresAt) return null;
    const ms = Date.parse(result.expiresAt);
    return Number.isFinite(ms) ? ms : null;
}

function isTerminalResult(
    result: DepositAddressStatusResponse,
    expiresAtMs: number | null,
    stopOnNotFound: boolean,
): boolean {
    if (!result.found) return stopOnNotFound;
    if (isDepositAddressUsed(result.status)) return true;
    if (isDepositAddressExpired(expiresAtMs)) return true;
    return false;
}

/**
 * Poll confidential deposit-address status.
 * Stops when used/expired; optionally when history returns not found (share pages).
 */
export function useDepositAddressStatus(options: {
    enabled: boolean;
    accountId: string | null | undefined;
    depositAddress: string | null | undefined;
    /**
     * Share pages: stop on history miss (invalid/unknown id).
     * Modal after mint: keep polling until the quote appears or is used/expired.
     */
    stopOnNotFound?: boolean;
}): DepositAddressStatusState {
    const {
        enabled,
        accountId,
        depositAddress,
        stopOnNotFound = true,
    } = options;
    const [state, setState] = useState<DepositAddressStatusState>(IDLE);

    useEffect(() => {
        if (!enabled || !accountId || !depositAddress) {
            setState(IDLE);
            return;
        }

        let cancelled = false;
        let intervalId: number | null = null;
        setState(IDLE);

        const stop = () => {
            if (intervalId != null) {
                window.clearInterval(intervalId);
                intervalId = null;
            }
        };

        const poll = async () => {
            try {
                const result = await fetchDepositAddressStatus(
                    accountId,
                    depositAddress,
                );
                if (cancelled) return;

                const expiresAtMs = parseExpiresAtMs(result);
                const terminal = isTerminalResult(
                    result,
                    expiresAtMs,
                    stopOnNotFound,
                );
                setState({
                    hasFetched: true,
                    found: result.found,
                    status: result.status ?? null,
                    expiresAtMs,
                    originAsset:
                        result.originAsset || result.destinationAsset || null,
                    destinationAsset: result.destinationAsset ?? null,
                    isTerminal: terminal,
                });
                if (terminal) stop();
            } catch {
                if (cancelled) return;
                // Keep polling on transient errors; mark fetched so UI can proceed.
                setState((prev) => ({
                    ...prev,
                    hasFetched: true,
                }));
            }
        };

        void poll();
        intervalId = window.setInterval(poll, POLL_MS);

        return () => {
            cancelled = true;
            stop();
        };
    }, [enabled, accountId, depositAddress, stopOnNotFound]);

    return state;
}

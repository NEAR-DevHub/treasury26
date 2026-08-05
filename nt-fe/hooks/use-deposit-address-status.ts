"use client";

import { useQuery } from "@tanstack/react-query";
import {
    isDepositAddressExpired,
    isDepositAddressUsed,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-expires";
import {
    type ConfidentialDepositAddressStatusResponse,
    fetchConfidentialDepositAddressStatus,
} from "@/lib/bridge-api";

const POLL_MS = 15_000;

export type DepositAddressStatusState = {
    hasFetched: boolean;
    found: boolean | null;
    status: string | null;
    expiresAtMs: number | null;
    originAsset: string | null;
    /** True when used, expired, or history miss after a successful fetch. */
    isTerminal: boolean;
};

const IDLE: DepositAddressStatusState = {
    hasFetched: false,
    found: null,
    status: null,
    expiresAtMs: null,
    originAsset: null,
    isTerminal: false,
};

function parseExpiresAtMs(
    result: ConfidentialDepositAddressStatusResponse,
): number | null {
    if (!result.expiresAt) return null;
    const ms = Date.parse(result.expiresAt);
    return Number.isFinite(ms) ? ms : null;
}

function isTerminalResult(
    result: ConfidentialDepositAddressStatusResponse,
    stopOnNotFound: boolean,
): boolean {
    if (!result.found) return stopOnNotFound;
    const expiresAtMs = parseExpiresAtMs(result);
    if (isDepositAddressUsed(result.status)) return true;
    if (isDepositAddressExpired(expiresAtMs)) return true;
    return false;
}

/**
 * Poll confidential deposit-address status via React Query.
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

    const query = useQuery({
        queryKey: [
            "confidential-deposit-address-status",
            accountId,
            depositAddress,
        ],
        queryFn: () =>
            fetchConfidentialDepositAddressStatus(accountId!, depositAddress!),
        enabled: enabled && !!accountId && !!depositAddress,
        staleTime: POLL_MS,
        refetchInterval: (q) => {
            const data = q.state.data;
            if (!data) return POLL_MS;
            return isTerminalResult(data, stopOnNotFound) ? false : POLL_MS;
        },
        retry: 1,
    });

    if (!enabled || !accountId || !depositAddress) {
        return IDLE;
    }

    if (!query.isFetched && !query.isError) {
        return IDLE;
    }

    const data = query.data;
    if (!data) {
        // Transient error: mark fetched so UI can proceed; keep polling.
        return {
            ...IDLE,
            hasFetched: true,
        };
    }

    const expiresAtMs = parseExpiresAtMs(data);
    return {
        hasFetched: true,
        found: data.found,
        status: data.status ?? null,
        expiresAtMs,
        originAsset: data.originAsset ?? null,
        isTerminal: isTerminalResult(data, stopOnNotFound),
    };
}

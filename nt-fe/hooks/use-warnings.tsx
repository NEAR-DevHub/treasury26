"use client";

import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
} from "react";
import type { Proposal } from "@/lib/proposals-api";
import {
    getProposalRequiredFunds,
    getProposalUIKind,
} from "@/features/proposals/utils/proposal-utils";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { resolveBridgeScope } from "@/lib/bridge-asset-resolver";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;
const WARNINGS_POLL_INTERVAL_MS = 15_000;

export type WarningSeverity = "info" | "warning" | "critical";

export interface Warning {
    id: number;
    slot: string | null;
    token: string | null;
    network: string | null;
    severity: WarningSeverity;
    message: string;
    showFrom: string | null;
    startsAt: string | null;
    endsAt: string | null;
}

/**
 * The word that replaces the {action} placeholder per slot/page context.
 * Mirrors ACTION_BY_SLOT in the backend admin form.
 */
const ACTION_BY_SLOT: Record<string, string> = {
    payments: "payment",
    deposit: "deposit",
    exchange: "swap",
    "action.vote": "vote",
    "action.create-proposal": "proposal",
};

export function getActionWord(slot: string | null | undefined): string {
    if (!slot) return "transaction";
    return ACTION_BY_SLOT[slot] ?? "transaction";
}

/** Replace the {action} placeholder in a templated message. */
export function fillAction(
    message: string,
    slotOrAction: string | null | undefined,
): string {
    const action =
        ACTION_BY_SLOT[slotOrAction ?? ""] ?? slotOrAction ?? "transaction";
    return message.replace(/\{action\}/g, action);
}

interface WarningsApiResponse {
    warnings: Warning[];
}

const SEVERITY_RANK: Record<WarningSeverity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
};

function normalizeToken(value: string | null | undefined): string | null {
    if (!value) return null;
    return value.trim().toLowerCase();
}

function getParentSlots(slot: string): string[] {
    const parts = slot.split(".");
    const parents: string[] = [];
    for (let i = parts.length - 1; i > 0; i -= 1) {
        parents.push(parts.slice(0, i).join("."));
    }
    return parents;
}

function getCandidateSlots(slot: string): string[] {
    return [slot, ...getParentSlots(slot)];
}

function warningMatchesQuery(
    warning: Warning,
    slot: string,
    token?: string,
    network?: string,
): boolean {
    const normalizedToken = normalizeToken(token);
    const normalizedNetwork = normalizeToken(network);
    const warningToken = normalizeToken(warning.token);
    const warningNetwork = normalizeToken(warning.network);

    if (warningToken && warningToken !== normalizedToken) {
        return false;
    }

    if (warningNetwork && warningNetwork !== normalizedNetwork) {
        return false;
    }

    if (!warning.slot) {
        return Boolean(warningToken || warningNetwork);
    }

    const candidateSlots = getCandidateSlots(slot);
    if (candidateSlots.includes(warning.slot)) {
        return true;
    }

    return slot.startsWith(`${warning.slot}.`);
}

function pickBestWarning(warnings: Warning[]): Warning | null {
    if (!warnings.length) return null;

    return warnings.reduce((best, current) => {
        const bestSpecificity = best.slot?.split(".").length ?? 0;
        const currentSpecificity = current.slot?.split(".").length ?? 0;

        if (currentSpecificity > bestSpecificity) {
            return current;
        }

        if (currentSpecificity < bestSpecificity) {
            return best;
        }

        return SEVERITY_RANK[current.severity] > SEVERITY_RANK[best.severity]
            ? current
            : best;
    });
}

async function fetchWarnings(): Promise<Warning[]> {
    const { data } = await axios.get<WarningsApiResponse | Warning[]>(
        `${BACKEND_API_BASE}/warnings`,
        { timeout: 10_000 },
    );

    if (Array.isArray(data)) {
        return data;
    }

    return data.warnings ?? [];
}

interface WarningsContextValue {
    warnings: Warning[];
    backendDown: boolean;
    isLoading: boolean;
    getWarning: (
        slot: string,
        token?: string,
        network?: string,
    ) => Warning | null;
    hasWarning: (slot: string, token?: string, network?: string) => boolean;
}

const WarningsContext = createContext<WarningsContextValue | null>(null);

export function WarningsProvider({ children }: { children: ReactNode }) {
    const { data, isError, isLoading } = useQuery({
        queryKey: ["warnings"],
        queryFn: fetchWarnings,
        refetchInterval: WARNINGS_POLL_INTERVAL_MS,
        staleTime: WARNINGS_POLL_INTERVAL_MS,
        retry: false,
    });

    const warnings = data ?? [];
    const backendDown = isError;

    const getWarning = useCallback(
        (slot: string, token?: string, network?: string): Warning | null => {
            const matches = warnings.filter((warning) =>
                warningMatchesQuery(warning, slot, token, network),
            );
            return pickBestWarning(matches);
        },
        [warnings],
    );

    const hasWarning = useCallback(
        (slot: string, token?: string, network?: string): boolean =>
            getWarning(slot, token, network) !== null,
        [getWarning],
    );

    const value = useMemo(
        () => ({
            warnings,
            backendDown,
            isLoading,
            getWarning,
            hasWarning,
        }),
        [warnings, backendDown, isLoading, getWarning, hasWarning],
    );

    return (
        <WarningsContext.Provider value={value}>
            {children}
        </WarningsContext.Provider>
    );
}

export function useWarnings(): WarningsContextValue {
    const context = useContext(WarningsContext);
    if (!context) {
        throw new Error("useWarnings must be used within a WarningsProvider");
    }
    return context;
}

/**
 * Transaction-action slots that get blocked by an app-level critical warning
 * (Tier 2+ "transactions paused" / "app down" / "under investigation").
 */
const TX_ACTION_SLOTS = new Set([
    "payments",
    "exchange",
    "deposit",
    "action.vote",
    "action.create-proposal",
]);

/**
 * Resolve whether a slot's action should be blocked. A `critical` warning
 * blocks the action (disable / relabel the CTA); `warning`/`info` only show a
 * message. An app-level critical warning blocks all transaction actions.
 * Returns the matched warning plus a ready-to-use short label.
 */
export function useSlotBlock(slot: string, token?: string, network?: string) {
    const { getWarning } = useWarnings();
    const warning = getWarning(slot, token, network);

    const appWarning = TX_ACTION_SLOTS.has(slot) ? getWarning("app") : null;
    const appBlocks = appWarning?.severity === "critical";

    const blocked = warning?.severity === "critical" || appBlocks;
    const effective =
        warning?.severity === "critical"
            ? warning
            : appBlocks
              ? appWarning
              : warning;

    return {
        warning: effective,
        blocked,
        message: effective?.message
            ? fillAction(effective.message, slot)
            : null,
    };
}

/**
 * Whether a live warning on `slot` targets a specific token or network.
 * Useful for gating bridge-token fetches (only needed to resolve token/network
 * ids when such a warning exists).
 */
export function useHasTokenOrNetworkWarning(slot: string): boolean {
    const { warnings } = useWarnings();
    return useMemo(
        () =>
            warnings.some(
                (w) =>
                    w.slot === slot && (Boolean(w.token) || Boolean(w.network)),
            ),
        [warnings, slot],
    );
}

/**
 * Maps a proposal's UI kind to the feature warning slot that governs it. Only
 * payments and exchange proposals can be paused; other kinds have no feature
 * slot and are never blocked by maintenance.
 */
const PROPOSAL_KIND_TO_SLOT: Record<string, string> = {
    "Payment Request": "payments",
    "Batch Payment Request": "payments",
    "Confidential Request": "payments",
    Exchange: "exchange",
};

export interface ProposalApproveBlock {
    /** True when at least one proposal can't be approved right now. */
    anyBlocked: boolean;
    /** Number of proposals blocked from approval. */
    blockedCount: number;
    /** Unique critical warnings (with their messages) causing the block. */
    blockedWarnings: Warning[];
}

/**
 * Determine whether approving the given proposals is blocked because their
 * feature (payments / exchange) currently has a critical warning. Rejection is
 * never blocked, so callers should only apply this for the "Approve" action.
 */
export function useProposalApproveBlock(
    proposals: Proposal[],
): ProposalApproveBlock {
    const { getWarning } = useWarnings();
    // Bridge tokens are only needed to resolve a proposal's token to the asset /
    // network ids a scoped warning is stored against. Skip that fetch entirely
    // unless a token/network-scoped payments/exchange warning is actually live.
    const hasTokenOrNetworkFeatureWarning =
        useHasTokenOrNetworkWarning("payments") ||
        useHasTokenOrNetworkWarning("exchange");
    const { data: bridgeAssets = [] } = useBridgeTokens(
        hasTokenOrNetworkFeatureWarning,
        { includeNearNetwork: true },
    );

    return useMemo(() => {
        let blockedCount = 0;
        const warningsById = new Map<number, Warning>();

        for (const proposal of proposals) {
            const uiKind = getProposalUIKind(proposal);
            const slot = PROPOSAL_KIND_TO_SLOT[uiKind];
            if (!slot) continue;

            // Resolve the proposal's token to the bridge asset/network ids so a
            // warning scoped to a specific token or network only blocks
            // proposals that actually use it. A feature-wide warning (no
            // token/network) still matches every proposal of that type.
            const funds = getProposalRequiredFunds(proposal);
            const scope = resolveBridgeScope(bridgeAssets, funds?.tokenId);

            const warning = getWarning(
                slot,
                scope.token ?? undefined,
                scope.networkName ?? undefined,
            );
            if (warning?.severity === "critical") {
                blockedCount += 1;
                warningsById.set(warning.id, warning);
            }
        }

        return {
            anyBlocked: blockedCount > 0,
            blockedCount,
            blockedWarnings: Array.from(warningsById.values()),
        };
    }, [proposals, getWarning, bridgeAssets]);
}

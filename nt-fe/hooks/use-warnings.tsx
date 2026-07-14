"use client";

import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { useTranslations } from "next-intl";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
} from "react";
import { useFormatDate } from "@/components/formatted-date";
import {
    getProposalRequiredFunds,
    getProposalUIKind,
} from "@/features/proposals/utils/proposal-utils";
import { type BridgeAsset, useBridgeTokens } from "@/hooks/use-bridge-tokens";
import {
    type BridgeScope,
    resolveBridgeScope,
} from "@/lib/bridge-asset-resolver";
import type { Proposal } from "@/lib/proposals-api";
import {
    actionKeyForSlot,
    fillStoredWarningMessage,
    formatWarningNetwork,
    formatWarningScheduleText,
    formatWarningToken,
    situationHidesUserMessage,
    situationMessageKey,
    situationUsesCustomCopy,
    WARNING_STATUS_PAGE_LINK,
    walletFromLoginSlot,
} from "@/lib/warnings";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;
const WARNINGS_POLL_INTERVAL_MS = 15_000;

/** Sentinel id for the client-only fallback when /api/warnings is unreachable. */
const BACKEND_DOWN_FALLBACK_ID = -1;

/** Matches shared/status-situations.json `backend_down` (app / notice / high). */
function buildBackendDownFallback(): Warning {
    return {
        id: BACKEND_DOWN_FALLBACK_ID,
        slot: "app",
        token: null,
        network: null,
        response: "notice",
        severity: "high",
        situation: "backend_down",
        message: null,
        showFrom: null,
        startsAt: null,
        endsAt: null,
    };
}

export type WarningResponse = "notice" | "paused";
export type WarningSeverity = "low" | "high" | "critical";

export interface Warning {
    id: number;
    slot: string | null;
    token: string | null;
    network: string | null;
    response: WarningResponse;
    severity: WarningSeverity;
    situation: string | null;
    message: string | null;
    /** When true, show stored message as-is instead of translated catalog copy. */
    useCustomMessage?: boolean;
    showFrom: string | null;
    startsAt: string | null;
    endsAt: string | null;
}

/** Replace the `{action}` placeholder in a templated message. */
export function fillAction(
    message: string,
    slotOrAction: string | null | undefined,
    actionBySlot: Record<string, string>,
): string {
    const action =
        actionBySlot[slotOrAction ?? ""] ?? slotOrAction ?? "transaction";
    return message.replace(/\{action\}/g, action);
}

interface WarningsApiResponse {
    warnings: Warning[];
    actionBySlot: Record<string, string>;
}

const SEVERITY_RANK: Record<WarningSeverity, number> = {
    low: 0,
    high: 1,
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

async function fetchWarnings(): Promise<{
    warnings: Warning[];
    actionBySlot: Record<string, string>;
}> {
    const { data } = await axios.get<WarningsApiResponse>(
        `${BACKEND_API_BASE}/warnings`,
        { timeout: 10_000 },
    );

    return {
        warnings: data.warnings ?? [],
        actionBySlot: data.actionBySlot ?? {},
    };
}

/** True when the backend (or its DB) is unreachable / unhealthy. */
async function fetchBackendHealthy(): Promise<boolean> {
    try {
        const { data } = await axios.get<{ status?: string }>(
            `${BACKEND_API_BASE}/health`,
            { timeout: 10_000 },
        );
        return data?.status === "healthy";
    } catch {
        return false;
    }
}

interface WarningsContextValue {
    warnings: Warning[];
    actionBySlot: Record<string, string>;
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
    const {
        data,
        isLoading,
        isError: warningsFailed,
    } = useQuery({
        queryKey: ["warnings"],
        queryFn: fetchWarnings,
        refetchInterval: WARNINGS_POLL_INTERVAL_MS,
        staleTime: WARNINGS_POLL_INTERVAL_MS,
        retry: false,
    });

    // Only hit /api/health when warnings already failed — confirms a real
    // backend/DB outage vs a warnings-route-only problem. Poll while that
    // failure persists so the banner clears (or reappears) correctly.
    const { data: backendHealthy = true } = useQuery({
        queryKey: ["backend-health"],
        queryFn: fetchBackendHealthy,
        enabled: warningsFailed,
        refetchInterval: WARNINGS_POLL_INTERVAL_MS,
        staleTime: WARNINGS_POLL_INTERVAL_MS,
        retry: false,
    });

    const showBackendDownFallback = warningsFailed && !backendHealthy;

    const warnings = useMemo(() => {
        const apiWarnings = data?.warnings ?? [];
        if (!showBackendDownFallback) {
            return apiWarnings;
        }
        const hasBackendDown = apiWarnings.some(
            (w) => w.situation === "backend_down",
        );
        return hasBackendDown
            ? apiWarnings
            : [...apiWarnings, buildBackendDownFallback()];
    }, [data?.warnings, showBackendDownFallback]);
    const actionBySlot = data?.actionBySlot ?? {};

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
            actionBySlot,
            isLoading,
            getWarning,
            hasWarning,
        }),
        [warnings, actionBySlot, isLoading, getWarning, hasWarning],
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

// ─── Warning message hooks ────────────────────────────────────────────────────

export function useResolveWarningMessage(): (
    warning: Warning | null | undefined,
    slot: string,
) => string | null {
    const formatDate = useFormatDate();
    const t = useTranslations("warnings");
    const tSituations = useTranslations("warnings.situations");

    const getAction = useCallback(
        (effectiveSlot: string) => {
            const key = actionKeyForSlot(effectiveSlot);
            switch (key) {
                case "payment":
                    return t("actions.payment");
                case "deposit":
                    return t("actions.deposit");
                case "exchange":
                    return t("actions.exchange");
                case "approve":
                    return t("actions.approve");
                case "reject":
                    return t("actions.reject");
                case "remove":
                    return t("actions.remove");
                case "proposal":
                    return t("actions.proposal");
                default:
                    return t("actions.transaction");
            }
        },
        [t],
    );

    // Subject ("X on Y") goes through i18n so translators control word order.
    const buildSubject = useCallback(
        (token: string | null, network: string | null) => {
            const tk = formatWarningToken(token);
            const nw = formatWarningNetwork(network);
            if (tk && nw) {
                return t("subject.tokenOnNetwork", { token: tk, network: nw });
            }
            return tk || nw || "";
        },
        [t],
    );

    const statusPageLink = t.has("statusPageLink")
        ? t("statusPageLink")
        : WARNING_STATUS_PAGE_LINK;
    const scheduleLabels = useMemo(
        () => ({ on: t("schedule.on"), until: t("schedule.until") }),
        [t],
    );

    return useCallback(
        (warning: Warning | null | undefined, slot: string) => {
            if (!warning) return null;

            const situationId = warning.situation?.trim();
            const effectiveSlot = warning.slot ?? slot;

            if (situationId && situationHidesUserMessage(situationId)) {
                return null;
            }

            const schedule = formatWarningScheduleText(
                formatDate,
                warning.startsAt,
                warning.endsAt,
                scheduleLabels,
            );
            const action = getAction(effectiveSlot);
            const runtimeValues = {
                action,
                schedule,
                statusPageLink,
            };

            const stored = warning.message?.trim();
            // Explicit admin override, or catalog situations that always use
            // free-form copy (e.g. funds_at_risk).
            if (
                stored &&
                (warning.useCustomMessage ||
                    (situationId && situationUsesCustomCopy(situationId)))
            ) {
                return fillStoredWarningMessage(stored, runtimeValues);
            }

            if (situationId) {
                const messageKey = situationMessageKey(
                    situationId,
                    effectiveSlot,
                    { token: warning.token, network: warning.network },
                );
                if (messageKey && tSituations.has(messageKey)) {
                    return tSituations(messageKey, {
                        subject: buildSubject(warning.token, warning.network),
                        token: formatWarningToken(warning.token),
                        network: formatWarningNetwork(warning.network),
                        wallet: walletFromLoginSlot(warning.slot),
                        action,
                        schedule,
                        statusPageLink,
                    });
                }
            }

            if (!stored) return null;
            return fillStoredWarningMessage(stored, runtimeValues);
        },
        [
            formatDate,
            tSituations,
            getAction,
            buildSubject,
            statusPageLink,
            scheduleLabels,
        ],
    );
}

export function useWarningMessage(
    warning: Warning | null | undefined,
    slot: string,
): string | null {
    const resolveMessage = useResolveWarningMessage();
    return useMemo(
        () => resolveMessage(warning, slot),
        [resolveMessage, warning, slot],
    );
}

export function useWarningOfflineBadgeLabel(): string {
    const t = useTranslations("warnings");
    return t("offlineBadge");
}

// ─── Slot-block hooks ─────────────────────────────────────────────────────────

/**
 * Transaction-action slots that get blocked by an app-level paused warning
 * (Tier 2+ "transactions paused" / "app down" / "under investigation").
 */
const TX_ACTION_SLOTS = new Set([
    "payments",
    "exchange",
    "deposit",
    "action.approve",
    "action.reject",
    "action.remove",
    "action.create-proposal",
]);

/**
 * Resolve whether a slot's action should be blocked. A `paused` response
 * blocks the action (disable / relabel the CTA); `notice` only shows a
 * message. An app-level paused warning blocks all transaction actions.
 * Returns the matched warning plus a ready-to-use short label.
 */
export function useSlotBlock(slot: string, token?: string, network?: string) {
    const { getWarning } = useWarnings();
    const warning = getWarning(slot, token, network);

    const appWarning = TX_ACTION_SLOTS.has(slot) ? getWarning("app") : null;
    const appBlocks = appWarning?.response === "paused";

    const blocked = warning?.response === "paused" || appBlocks;
    const effective =
        warning?.response === "paused"
            ? warning
            : appBlocks
              ? appWarning
              : warning;

    const effectiveSlot = effective?.slot ?? slot;
    const message = useWarningMessage(effective, effectiveSlot);

    return {
        warning: effective,
        blocked,
        message,
    };
}

/** True when a warning targets a specific token or network (not slot-wide). */
export function isTokenOrNetworkScopedWarning(
    warning: Warning | null | undefined,
): boolean {
    return Boolean(warning?.token || warning?.network);
}

/** Inline field copy — null for slot-wide banners, message when token/network scoped. */
export function scopedFieldMessage(
    warning: Warning | null | undefined,
    message: string | null | undefined,
): string | null {
    if (!message || !isTokenOrNetworkScopedWarning(warning)) {
        return null;
    }
    return message;
}

export interface ScopedSlotWarning {
    warning: Warning | null;
    blocked: boolean;
    message: string | null;
    scopedMessage: string | null;
}

/** `useSlotBlock` plus a token/network-scoped message for inline field hints. */
export function useScopedSlotWarning(
    slot: string,
    token?: string,
    network?: string,
): ScopedSlotWarning {
    const slotBlock = useSlotBlock(slot, token, network);
    const scopedMessage = useMemo(
        () => scopedFieldMessage(slotBlock.warning, slotBlock.message),
        [slotBlock.warning, slotBlock.message],
    );

    return { ...slotBlock, scopedMessage };
}

export interface BridgeScopedWarning extends ScopedSlotWarning {
    scope: BridgeScope;
}

/** Resolve bridge scope from a token address, then check slot warnings. */
export function useBridgeScopedWarning(
    slot: string,
    bridgeAssets: BridgeAsset[],
    tokenAddress?: string | null,
): BridgeScopedWarning {
    const scope = useMemo(
        () => resolveBridgeScope(bridgeAssets, tokenAddress),
        [bridgeAssets, tokenAddress],
    );
    const result = useScopedSlotWarning(
        slot,
        scope.token ?? undefined,
        scope.networkName ?? undefined,
    );

    return { ...result, scope };
}

/** Fetch bridge assets only when a token/network-scoped warning is live on `slot`. */
export function useBridgeAssetsForWarnings(
    slot: string,
    options?: { includeNearNetwork?: boolean },
) {
    const enabled = useHasTokenOrNetworkWarning(slot);
    return useBridgeTokens(enabled, options);
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
    /** Unique paused warnings (with their messages) causing the block. */
    blockedWarnings: Warning[];
}

/**
 * Determine whether approving the given proposals is blocked because their
 * feature (payments / exchange) currently has a paused warning. Rejection is
 * never blocked, so callers should only apply this for the "Approve" action.
 */
export function useProposalApproveBlock(
    proposals: Proposal[],
): ProposalApproveBlock {
    const { getWarning } = useWarnings();
    // Bridge tokens are only needed to resolve a proposal's token to the asset /
    // network ids a scoped warning is stored against. Skip that fetch entirely
    // unless a token/network-scoped payments/exchange warning is actually live.
    const hasPaymentsTokenOrNetworkWarning =
        useHasTokenOrNetworkWarning("payments");
    const hasExchangeTokenOrNetworkWarning =
        useHasTokenOrNetworkWarning("exchange");
    const hasTokenOrNetworkFeatureWarning =
        hasPaymentsTokenOrNetworkWarning || hasExchangeTokenOrNetworkWarning;
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
            if (warning?.response === "paused") {
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

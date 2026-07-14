import type { QueryClient } from "@tanstack/react-query";

export const APP_EVENT_TYPES = {
    treasuryProjectionUpdated: "treasury_projection_updated",
} as const;

export const APP_EVENT_NAMES = Object.values(APP_EVENT_TYPES);

export type TreasuryProjectionUpdatedEvent = {
    type: typeof APP_EVENT_TYPES.treasuryProjectionUpdated;
    accountId: string;
    emittedAt: string;
};

export type AppEvent = TreasuryProjectionUpdatedEvent;

export type AppEventScope = {
    treasuryId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object";
}

function parseTreasuryProjectionUpdatedEvent(
    value: Record<string, unknown>,
): TreasuryProjectionUpdatedEvent | null {
    if (
        value.type !== APP_EVENT_TYPES.treasuryProjectionUpdated ||
        typeof value.accountId !== "string" ||
        typeof value.emittedAt !== "string"
    ) {
        return null;
    }

    return {
        type: APP_EVENT_TYPES.treasuryProjectionUpdated,
        accountId: value.accountId,
        emittedAt: value.emittedAt,
    };
}

export function parseAppEvent(raw: string): AppEvent | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
    }

    switch (value.type) {
        case APP_EVENT_TYPES.treasuryProjectionUpdated:
            return parseTreasuryProjectionUpdatedEvent(value);
        default:
            return null;
    }
}

async function invalidateTreasuryProjectionQueries(
    queryClient: QueryClient,
    event: TreasuryProjectionUpdatedEvent,
    scope: AppEventScope,
) {
    if (!scope.treasuryId || event.accountId !== scope.treasuryId) {
        return;
    }

    await Promise.all([
        queryClient.invalidateQueries({
            queryKey: ["recentActivity", event.accountId],
        }),
        queryClient.invalidateQueries({
            queryKey: ["treasuryAssets", event.accountId],
        }),
        queryClient.invalidateQueries({
            queryKey: ["balanceChart", event.accountId],
        }),
        queryClient.invalidateQueries({
            queryKey: ["recentActivitySenders", event.accountId],
        }),
        queryClient.invalidateQueries({
            queryKey: ["recentActivityRecipients", event.accountId],
        }),
    ]);
}

export async function handleAppEvent(
    queryClient: QueryClient,
    event: AppEvent,
    scope: AppEventScope,
) {
    switch (event.type) {
        case APP_EVENT_TYPES.treasuryProjectionUpdated:
            await invalidateTreasuryProjectionQueries(
                queryClient,
                event,
                scope,
            );
            return;
    }
}

/** Highlight remaining time in red when under 24 hours. */
export const DEPOSIT_EXPIRY_URGENT_MS = 24 * 60 * 60 * 1000;

/** Must stay in sync with backend `DEPOSIT_ADDRESS_VALIDITY_DAYS`. */
export const DEPOSIT_ADDRESS_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const PENDING_DEPOSIT_STATUS = "PENDING_DEPOSIT";

const USED_OR_TERMINAL_STATUSES = new Set([
    "SUCCESS",
    "FAILED",
    "REFUNDED",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "KNOWN_DEPOSIT_TX",
    "EXPIRED",
]);

export function isDepositExpiryUrgent(
    expiresAtMs: number,
    nowMs: number = Date.now(),
): boolean {
    const remaining = expiresAtMs - nowMs;
    return remaining > 0 && remaining < DEPOSIT_EXPIRY_URGENT_MS;
}

export function isDepositAddressExpired(
    expiresAtMs: number | null | undefined,
    nowMs: number = Date.now(),
): boolean {
    if (expiresAtMs == null || !Number.isFinite(expiresAtMs)) return false;
    return nowMs >= expiresAtMs;
}

/** Quote has already received a deposit or reached a terminal/used state. */
export function isDepositAddressUsed(status: string | null | undefined): boolean {
    if (!status) return false;
    const normalized = status.trim().toUpperCase();
    if (normalized === PENDING_DEPOSIT_STATUS) return false;
    return USED_OR_TERMINAL_STATUSES.has(normalized);
}

export function resolveExpiresAtMs(params: {
    expiresAtMs?: number | null;
    createdAt?: string | null;
}): number | null {
    if (
        params.expiresAtMs != null &&
        Number.isFinite(params.expiresAtMs)
    ) {
        return params.expiresAtMs;
    }
    if (!params.createdAt) return null;
    const created = Date.parse(params.createdAt);
    if (!Number.isFinite(created)) return null;
    return created + DEPOSIT_ADDRESS_VALIDITY_MS;
}

function formatDurationUnit(
    locale: string,
    duration: Record<string, number>,
): string {
    const DurationFormat = (
        Intl as unknown as {
            DurationFormat?: new (
                locales?: string | string[],
                options?: { style?: string },
            ) => { format: (duration: Record<string, number>) => string };
        }
    ).DurationFormat;

    if (DurationFormat) {
        return new DurationFormat(locale, { style: "long" }).format(duration);
    }
    const [[unit, value]] = Object.entries(duration);
    return `${value} ${unit}`;
}

/**
 * Human remaining duration for “Expires in {duration}”.
 * - ≥ 24h: days, rounded up (ceil) so ~14d remaining still shows “14 days”
 * - < 24h: hours (ceil), shown in red by the caller
 * - < 1h: minutes (ceil, at least 1 while still active)
 */
export function formatDepositRemainingDuration(
    expiresAtMs: number,
    locale: string,
    nowMs: number = Date.now(),
): string {
    const remainingMs = Math.max(0, expiresAtMs - nowMs);

    if (remainingMs >= DAY_MS) {
        return formatDurationUnit(locale, {
            days: Math.ceil(remainingMs / DAY_MS),
        });
    }

    if (remainingMs >= HOUR_MS) {
        return formatDurationUnit(locale, {
            hours: Math.ceil(remainingMs / HOUR_MS),
        });
    }

    return formatDurationUnit(locale, {
        minutes: Math.max(1, Math.ceil(remainingMs / MINUTE_MS)),
    });
}

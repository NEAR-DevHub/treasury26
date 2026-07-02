import catalog from "@/lib/generated/status-situations.json";

// ─── Catalog ─────────────────────────────────────────────────────────────────

export type WarningCatalogSituation = {
    id: string;
    message?: string;
    customCopy?: boolean;
    byPlacement?: Record<string, string>;
    messagesByScope?: Record<string, string>;
};

const situations = catalog.situations as WarningCatalogSituation[];

export const WARNING_STATUS_PAGE_LINK = catalog.statusPageLink;

export function placementKeyForSlot(slot: string): string {
    if (slot.startsWith("login.wallet.")) {
        return "login.wallet.*";
    }
    return slot;
}

export function getCatalogSituation(
    situationId: string,
): WarningCatalogSituation | undefined {
    return situations.find((s) => s.id === situationId);
}

export function situationUsesCustomCopy(situationId: string): boolean {
    return getCatalogSituation(situationId)?.customCopy === true;
}

export function situationHidesUserMessage(situationId: string): boolean {
    return situationId === "treasury_creation_unavailable";
}

// ─── Pure message helpers ─────────────────────────────────────────────────────

export function actionKeyForSlot(slot: string): string {
    switch (slot) {
        case "payments":
            return "payment";
        case "deposit":
            return "deposit";
        case "exchange":
            return "exchange";
        case "action.approve":
            return "approve";
        case "action.reject":
            return "reject";
        case "action.remove":
            return "remove";
        case "action.create-proposal":
            return "proposal";
        case "data.balances":
            return "transaction";
        default:
            return "transaction";
    }
}

export function walletFromLoginSlot(slot: string | null | undefined): string {
    if (!slot?.startsWith("login.wallet.")) return "";
    return slot.slice("login.wallet.".length).replace(/-/g, " ");
}

export function formatWarningToken(token: string | null | undefined): string {
    return token?.trim().toUpperCase() ?? "";
}

export function formatWarningNetwork(
    network: string | null | undefined,
): string {
    const n = network?.trim();
    if (!n) return "";
    return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

export function formatWarningScheduleText(
    formatDate: (date: Date | string | number) => string,
    startsAt: string | null | undefined,
    endsAt: string | null | undefined,
    labels: { on: string; until: string },
): string {
    const parts: string[] = [];
    if (startsAt) parts.push(`${labels.on} ${formatDate(startsAt)}`);
    if (endsAt) parts.push(`${labels.until} ${formatDate(endsAt)}`);
    return parts.join(" ");
}

/** Strip markdown headers, links and status-page lines for plain-text tooltips. */
export function stripMessageForTooltip(
    message: string | null | undefined,
): string {
    if (!message) return "";
    return message
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/\s*Updates:.*$/gm, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\n+/g, " ")
        .trim();
}

// ─── Message-key resolution ────────────────────────────────────────────────

// i18n keys can't contain dots, so "login.wallet.*" is stored as "loginWallet"
const I18N_KEY_MAP: Record<string, string> = {
    "login.wallet.*": "loginWallet",
};

function i18nPlacementKey(key: string): string {
    return I18N_KEY_MAP[key] ?? key;
}

/**
 * Resolves the i18n message path (relative to the `warnings.situations`
 * namespace) for a warning, e.g. `network_paused.token+network` or
 * `scheduled_maintenance.app`. The catalog only decides *which* key applies;
 * the translated copy lives in the messages files and is rendered by next-intl.
 */
export function situationMessageKey(
    situationId: string,
    slot: string,
    scope?: { token?: string | null; network?: string | null },
): string | null {
    const situation = getCatalogSituation(situationId);
    if (!situation) return null;

    if (situation.messagesByScope && scope) {
        const hasToken = Boolean(scope.token?.trim());
        const hasNetwork = Boolean(scope.network?.trim());
        const byScope = situation.messagesByScope;
        if (hasToken && hasNetwork && byScope["token+network"]) {
            return `${situationId}.token+network`;
        }
        if (hasToken && !hasNetwork && byScope.token) {
            return `${situationId}.token`;
        }
        if (hasNetwork && !hasToken && byScope.network) {
            return `${situationId}.network`;
        }
    }

    const placementCatalogKey = placementKeyForSlot(slot);
    if (situation.byPlacement?.[placementCatalogKey]) {
        return `${situationId}.${i18nPlacementKey(placementCatalogKey)}`;
    }
    if (situation.message) {
        return `${situationId}.default`;
    }
    return null;
}

/**
 * Fills the runtime placeholders of an admin-authored stored message. Stored
 * messages are free text (not i18n keys), so they can't go through next-intl —
 * this only substitutes the few values ops can reference.
 */
export function fillStoredWarningMessage(
    message: string,
    values: { action: string; schedule: string; statusPageLink: string },
): string {
    return message
        .replace(/\{action\}/g, values.action)
        .replace(/\{statusPageLink\}/g, values.statusPageLink)
        .replace(/\{schedule\}/g, values.schedule);
}

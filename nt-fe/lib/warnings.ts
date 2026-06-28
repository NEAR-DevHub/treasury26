import catalog from "@/lib/generated/status-situations.json";
import type { Warning } from "@/hooks/use-warnings";

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

function normalizeMessageNewlines(text: string): string {
    return text.replace(/\\n/g, "\n");
}

export function getCatalogTemplate(
    situationId: string,
    slot: string,
    scope?: { token?: string | null; network?: string | null },
): string | null {
    const situation = getCatalogSituation(situationId);
    if (!situation) return null;

    if (situation.messagesByScope && scope) {
        const hasToken = Boolean(scope.token?.trim());
        const hasNetwork = Boolean(scope.network?.trim());
        if (hasToken && hasNetwork) {
            const t = situation.messagesByScope["token+network"];
            if (t) return normalizeMessageNewlines(t);
        }
        if (hasToken && !hasNetwork) {
            const t = situation.messagesByScope.token;
            return t ? normalizeMessageNewlines(t) : null;
        }
        if (hasNetwork && !hasToken) {
            const t = situation.messagesByScope.network;
            return t ? normalizeMessageNewlines(t) : null;
        }
    }

    const placementKey = placementKeyForSlot(slot);
    const fromPlacement = situation.byPlacement?.[placementKey];
    if (fromPlacement) return normalizeMessageNewlines(fromPlacement);

    return situation.message
        ? normalizeMessageNewlines(situation.message)
        : null;
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
        case "action.vote":
            return "vote";
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

export function warningSubject(
    token: string | null | undefined,
    network: string | null | undefined,
): string {
    const t = token?.trim().toUpperCase();
    const n = network?.trim().toUpperCase();
    if (t && n) return `${t} on ${n}`;
    if (t) return t;
    if (n) return n;
    return "";
}

export function formatWarningScheduleText(
    formatDate: (date: Date | string | number) => string,
    startsAt: string | null | undefined,
    endsAt: string | null | undefined,
    labels: { on: string; until: string } = { on: "on", until: "until" },
): string {
    const parts: string[] = [];
    if (startsAt) parts.push(`${labels.on} ${formatDate(startsAt)}`);
    if (endsAt) parts.push(`${labels.until} ${formatDate(endsAt)}`);
    return parts.join(" ");
}

export function fillWarningTemplate(
    template: string,
    values: Record<string, string>,
): string {
    return template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => {
        return values[key] ?? match;
    });
}

export function hasUnfilledWarningPlaceholders(text: string): boolean {
    return /\{[a-zA-Z]+\}/.test(text);
}

const ADMIN_FILLED_PLACEHOLDERS = new Set(["requestType", "capability"]);

export function templateNeedsStoredMessageFallback(
    template: string,
    values: Record<string, string>,
): boolean {
    for (const match of template.matchAll(/\{([a-zA-Z]+)\}/g)) {
        const key = match[1];
        if (ADMIN_FILLED_PLACEHOLDERS.has(key) && !values[key]?.trim()) {
            return true;
        }
    }
    return false;
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

// ─── Resolver ─────────────────────────────────────────────────────────────────

// i18n keys can't contain dots, so "login.wallet.*" is stored as "loginWallet"
const I18N_KEY_MAP: Record<string, string> = {
    "login.wallet.*": "loginWallet",
};

function i18nPlacementKey(key: string): string {
    return I18N_KEY_MAP[key] ?? key;
}

export type WarningSituationOverrides = Record<
    string,
    Record<string, string> | undefined
>;

export type ResolveWarningMessageOptions = {
    slot: string;
    formatDate: (date: Date | string | number) => string;
    getAction: (slot: string) => string;
    statusPageLink: string;
    situationOverrides?: WarningSituationOverrides;
    scheduleLabels?: { on: string; until: string };
};

function pickSituationTemplate(
    situationId: string,
    slot: string,
    situationOverrides?: WarningSituationOverrides,
    scope?: { token?: string | null; network?: string | null },
): string | null {
    const overrideSituation = situationOverrides?.[situationId];
    if (overrideSituation) {
        const hasToken = Boolean(scope?.token?.trim());
        const hasNetwork = Boolean(scope?.network?.trim());
        if (hasToken && hasNetwork && overrideSituation["token+network"]) {
            return overrideSituation["token+network"];
        }
        if (hasToken && !hasNetwork && overrideSituation.token) {
            return overrideSituation.token;
        }
        if (hasNetwork && !hasToken && overrideSituation.network) {
            return overrideSituation.network;
        }
        const placementKey = i18nPlacementKey(placementKeyForSlot(slot));
        const override =
            overrideSituation[placementKey] ?? overrideSituation.default;
        if (override) return override;
    }
    return getCatalogTemplate(situationId, slot, scope);
}

function fillStoredMessageFallback(
    message: string,
    effectiveSlot: string,
    warning: Warning,
    options: ResolveWarningMessageOptions,
): string {
    const scheduleText = formatWarningScheduleText(
        options.formatDate,
        warning.startsAt,
        warning.endsAt,
        options.scheduleLabels,
    );
    let filled = message.replace(
        /\{action\}/g,
        options.getAction(effectiveSlot),
    );
    filled = filled.replace(/\{statusPageLink\}/g, options.statusPageLink);
    if (filled.includes("{schedule}")) {
        filled = filled.replace(/\{schedule\}/g, scheduleText);
    }
    return filled;
}

export function resolveWarningMessage(
    warning: Warning,
    options: ResolveWarningMessageOptions,
): string | null {
    const situationId = warning.situation?.trim();
    const effectiveSlot = warning.slot ?? options.slot;

    if (situationId && situationHidesUserMessage(situationId)) return null;
    if (situationId && situationUsesCustomCopy(situationId)) {
        return warning.message?.trim() || null;
    }

    if (situationId) {
        const template = pickSituationTemplate(
            situationId,
            effectiveSlot,
            options.situationOverrides,
            { token: warning.token, network: warning.network },
        );
        if (template) {
            const scheduleText = formatWarningScheduleText(
                options.formatDate,
                warning.startsAt,
                warning.endsAt,
                options.scheduleLabels,
            );
            const values = {
                subject: warningSubject(warning.token, warning.network),
                token: warning.token?.trim().toUpperCase() ?? "",
                network: warning.network?.trim().toUpperCase() ?? "",
                wallet: walletFromLoginSlot(warning.slot),
                action: options.getAction(effectiveSlot),
                schedule: scheduleText,
                statusPageLink: options.statusPageLink,
                requestType: "",
                capability: "",
            };
            if (!templateNeedsStoredMessageFallback(template, values)) {
                const filled = fillWarningTemplate(template, values);
                if (!hasUnfilledWarningPlaceholders(filled)) return filled;
            }
        }
    }

    const stored = warning.message?.trim();
    if (!stored) return null;
    return fillStoredMessageFallback(stored, effectiveSlot, warning, options);
}

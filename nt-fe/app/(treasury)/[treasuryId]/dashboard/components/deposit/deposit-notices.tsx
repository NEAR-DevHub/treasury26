import type { ReactNode } from "react";
import {
    formatDepositRemainingDuration,
    isDepositAddressExpired,
    isDepositExpiryUrgent,
} from "./deposit-expires";
import type { DepositNoticeItem } from "./deposit-notice-list";
import type { ConfidentialOrigin } from "./deposit-types";

/** Compatible with next-intl `useTranslations("depositModal")`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DepositTranslator = any;

/** next-intl rich tag: emphasize notice copy with foreground color (not font-weight). */
function richForeground(chunks: ReactNode) {
    return <span className="text-foreground">{chunks}</span>;
}

export function buildConfidentialOriginNotices(
    t: DepositTranslator,
    origin: ConfidentialOrigin,
): DepositNoticeItem[] {
    const onlyFromKey =
        origin === "trezu"
            ? "onlyFromConfidentialTrezu"
            : "onlyFromConfidentialNearcom";
    const outsideLost =
        origin === "trezu"
            ? t("fundsOutsideTrezuLost")
            : t("fundsOutsideNearcomLost");

    return [
        {
            id: "only-from",
            tone: "success",
            content: t.rich(onlyFromKey, { bold: richForeground }),
        },
        {
            id: "reusable",
            tone: "success",
            content: t.rich("reusableDoesntExpire", { bold: richForeground }),
        },
        {
            id: "outside-lost",
            tone: "danger",
            content: outsideLost,
        },
    ];
}

export function buildPublicWalletOneTimeNotices(
    t: DepositTranslator,
    symbol: string,
    network: string,
    options?: {
        expiresAtMs?: number | null;
        nowMs?: number;
        locale?: string;
    },
): DepositNoticeItem[] {
    const expiresAtMs = options?.expiresAtMs ?? null;
    const nowMs = options?.nowMs ?? Date.now();
    const locale = options?.locale ?? "en";
    const expired = isDepositAddressExpired(expiresAtMs, nowMs);
    const urgent =
        expiresAtMs != null && isDepositExpiryUrgent(expiresAtMs, nowMs);
    const duration =
        expiresAtMs != null && !expired
            ? formatDepositRemainingDuration(expiresAtMs, locale, nowMs)
            : null;

    return [
        {
            id: "only-send",
            tone: "danger",
            content: t.rich("onlySendAssetNetwork", {
                symbol,
                network,
                bold: richForeground,
            }),
        },
        {
            id: "no-test",
            tone: "danger",
            content: t.rich("doNotSendTestDeposit", { bold: richForeground }),
        },
        {
            id: "no-reuse",
            tone: "danger",
            content: t.rich("doNotReuseAddressShort", { bold: richForeground }),
        },
        {
            id: "expires",
            tone: expired ? "danger" : "success",
            content: expired
                ? t("addressExpired")
                : duration
                  ? t.rich("expiresInRemaining", {
                        duration,
                        bold: richForeground,
                        time: (chunks: ReactNode) => (
                            <span
                                className={
                                    urgent
                                        ? "text-destructive font-medium"
                                        : "text-foreground font-medium"
                                }
                            >
                                {chunks}
                            </span>
                        ),
                    })
                  : t.rich("expiresInDays", {
                        days: 14,
                        bold: richForeground,
                    }),
        },
    ];
}

export function buildPublicTreasuryNotices(
    t: DepositTranslator,
    network: string,
    minDepositDisplay: string | null,
    assetSymbol: string,
): DepositNoticeItem[] {
    const notices: DepositNoticeItem[] = [];

    if (minDepositDisplay) {
        notices.push({
            id: "min-deposit",
            tone: "success",
            content: t.rich("minimumDeposit", {
                amount: minDepositDisplay,
                symbol: assetSymbol,
                amountTag: richForeground,
            }),
        });
    }

    notices.push({
        id: "network-recommendation",
        tone: "success",
        content: t.rich("publicNetworkRecommendation", {
            network,
            bold: richForeground,
        }),
    });

    return notices;
}

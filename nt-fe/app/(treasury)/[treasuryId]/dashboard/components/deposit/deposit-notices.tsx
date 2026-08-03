import type { ReactNode } from "react";
import type { DepositNoticeItem } from "./deposit-notice-list";
import type { ConfidentialOrigin } from "./deposit-types";

/** Compatible with next-intl `useTranslations("depositModal")`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DepositTranslator = any;

function noticeBold(chunks: ReactNode) {
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
            content: t.rich(onlyFromKey, { bold: noticeBold }),
        },
        {
            id: "reusable",
            tone: "success",
            content: t.rich("reusableDoesntExpire", { bold: noticeBold }),
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
): DepositNoticeItem[] {
    return [
        {
            id: "only-send",
            tone: "danger",
            content: t.rich("onlySendAssetNetwork", {
                symbol,
                network,
                bold: noticeBold,
            }),
        },
        {
            id: "no-test",
            tone: "danger",
            content: t.rich("doNotSendTestDeposit", { bold: noticeBold }),
        },
        {
            id: "no-reuse",
            tone: "danger",
            content: t.rich("doNotReuseAddressShort", { bold: noticeBold }),
        },
        {
            id: "expires",
            tone: "success",
            content: t.rich("expiresInDays", {
                days: 14,
                bold: noticeBold,
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
                amountTag: (chunks: ReactNode) => (
                    <span className="text-foreground">{chunks}</span>
                ),
            }),
        });
    }

    notices.push({
        id: "network-recommendation",
        tone: "success",
        content: t.rich("publicNetworkRecommendation", {
            network,
            bold: (chunks: ReactNode) => (
                <span className="text-foreground">{chunks}</span>
            ),
        }),
    });

    return notices;
}

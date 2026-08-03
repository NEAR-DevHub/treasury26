"use client";

import { Clock, Link2, Zap } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { formatBalance } from "@/lib/utils";
import { DepositAddressCard } from "../../dashboard/components/deposit/deposit-address-card";
import { DepositConfidentialSourceTabs } from "../../dashboard/components/deposit/deposit-confidential-source-tabs";
import { DepositNoticeList } from "../../dashboard/components/deposit/deposit-notice-list";
import {
    buildConfidentialOriginNotices,
    buildPublicTreasuryNotices,
    buildPublicWalletOneTimeNotices,
} from "../../dashboard/components/deposit/deposit-notices";
import {
    resolvePayerTreasuryId,
    resolveSendTokenMeta,
} from "../../dashboard/components/deposit/deposit-transfer-resolve";
import { DepositTransferSummary } from "../../dashboard/components/deposit/deposit-transfer-summary";
import {
    getAbsoluteTransferUrl,
    parseTransferType,
} from "../../dashboard/components/deposit/deposit-transfer-url";
import type { ConfidentialOrigin } from "../../dashboard/components/deposit/deposit-types";

export default function DepositTransferPage() {
    const t = useTranslations("depositModal");
    const router = useRouter();
    const searchParams = useSearchParams();
    const { treasuryId, config, treasuries, lastTreasuryId, isConfidential } =
        useTreasury();
    const previousTreasuryIdRef = useRef(treasuryId);

    // Treasury switch keeps /deposit/transfer; send users back to main deposit.
    useEffect(() => {
        if (!treasuryId) return;
        if (
            previousTreasuryIdRef.current &&
            previousTreasuryIdRef.current !== treasuryId
        ) {
            router.replace(`/${treasuryId}/dashboard/deposit`);
        }
        previousTreasuryIdRef.current = treasuryId;
    }, [treasuryId, router]);

    const tokenId = searchParams.get("token") || "";
    const networkId = searchParams.get("network") || "";
    const addressParam = searchParams.get("address") || "";
    const type = parseTransferType(searchParams.get("type"), {
        hasPublicParams: Boolean(addressParam && (tokenId || networkId)),
    });

    // Destination treasury is always the dao id from the path; name comes from DB.
    const recipientDaoId = treasuryId || "";
    const depositAddress =
        type === "confidential"
            ? recipientDaoId
            : addressParam || recipientDaoId;
    const treasuryDisplayName = config?.name || recipientDaoId;

    const initialSource =
        searchParams.get("source") === "nearcom" ? "nearcom" : "trezu";
    const [confidentialOrigin, setConfidentialOrigin] =
        useState<ConfidentialOrigin>(initialSource);

    const { data: bridgeAssets = [] } = useBridgeTokens(type === "public", {
        includeNearNetwork: true,
    });

    const sendTokenMeta = useMemo(
        () =>
            type === "public"
                ? resolveSendTokenMeta(bridgeAssets, tokenId, networkId)
                : null,
        [type, bridgeAssets, tokenId, networkId],
    );

    const payerTreasuryId = useMemo(
        () => resolvePayerTreasuryId(treasuries, treasuryId, lastTreasuryId),
        [treasuries, treasuryId, lastTreasuryId],
    );

    const minDepositDisplay = useMemo(() => {
        if (!sendTokenMeta?.minDepositAmount) return null;
        return formatBalance(
            sendTokenMeta.minDepositAmount,
            sendTokenMeta.decimals,
        );
    }, [sendTokenMeta?.minDepositAmount, sendTokenMeta?.decimals]);

    const notices = useMemo(() => {
        if (type === "confidential") {
            return buildConfidentialOriginNotices(t, confidentialOrigin);
        }

        const symbol = sendTokenMeta?.symbol || tokenId;
        const network = sendTokenMeta?.networkName || networkId;

        // Public treasury share screen: min deposit + network recommendation.
        // Confidential one-time (public wallet) share: stricter one-time notices.
        if (!isConfidential) {
            return buildPublicTreasuryNotices(
                t,
                network,
                minDepositDisplay,
                symbol,
            );
        }

        return buildPublicWalletOneTimeNotices(t, symbol, network);
    }, [
        type,
        isConfidential,
        confidentialOrigin,
        sendTokenMeta?.symbol,
        sendTokenMeta?.networkName,
        minDepositDisplay,
        tokenId,
        networkId,
        t,
    ]);

    const handleCopyLink = async () => {
        const url = getAbsoluteTransferUrl(
            `${window.location.pathname}${window.location.search}`,
        );
        try {
            await navigator.clipboard.writeText(url);
            toast.success(t("linkCopied"));
        } catch {
            toast.error(t("errors.fetchFailed"));
        }
    };

    const handlePayWithTrezu = () => {
        if (!payerTreasuryId) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }

        const params = new URLSearchParams();
        if (type === "public") {
            // Only deep-link once address + network are ready (token confirms selection).
            if (!depositAddress || !tokenId || !networkId) {
                toast.error(t("transfer.payRequiresTreasury"));
                return;
            }
            params.set("address", depositAddress);
            params.set("networks", networkId);
        } else {
            if (!recipientDaoId) {
                toast.error(t("transfer.payRequiresTreasury"));
                return;
            }
            params.set("address", recipientDaoId);
            params.set("networks", NEAR_COM_NETWORK_ID);
        }

        router.push(`/${payerTreasuryId}/payments?${params.toString()}`);
    };

    const pageTitle =
        type === "confidential" || isConfidential
            ? t("transfer.titleConfidential")
            : t("transfer.title");

    return (
        <PageComponentLayout title={pageTitle}>
            <div className="flex justify-center w-full">
                <PageCard className="w-full max-w-150 gap-4">
                    <div className="flex items-start justify-between gap-3 pb-3 border-b border-general-border mb-3">
                        <h1 className="font-semibold text-lg leading-snug">
                            {pageTitle}
                        </h1>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-general-orange-background-faded text-general-orange-foreground px-2.5 py-1 text-xs font-medium shrink-0">
                            <Clock className="size-3.5" />
                            {t("transfer.waitingForPayment")}
                        </span>
                    </div>

                    {type === "confidential" && (
                        <DepositConfidentialSourceTabs
                            value={confidentialOrigin}
                            onChange={setConfidentialOrigin}
                        />
                    )}

                    <DepositTransferSummary
                        variant={type === "public" ? "public" : "confidential"}
                        sendTokenMeta={sendTokenMeta}
                        tokenId={tokenId}
                        networkId={networkId}
                        treasuryDisplayName={treasuryDisplayName}
                        treasuryLogo={config?.metadata?.flagLogo}
                        isConfidentialTreasury={isConfidential}
                    />

                    <DepositAddressCard
                        address={depositAddress}
                        copyMode="inline"
                        showShare={false}
                        footer={
                            <div className="px-3 py-2.5 border-t border-general-tertiary">
                                <DepositNoticeList notices={notices} />
                            </div>
                        }
                    />

                    <div className="space-y-2">
                        <Button
                            type="button"
                            onClick={handlePayWithTrezu}
                            className="w-full gap-2"
                            data-testid="deposit-pay-with-trezu"
                        >
                            <Zap className="size-4 fill-current" />
                            {t("transfer.payWithTrezu")}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={handleCopyLink}
                            className="w-full gap-2"
                            data-testid="deposit-copy-link"
                        >
                            <Link2 className="size-4" />
                            {t("transfer.copyLink")}
                        </Button>
                    </div>
                </PageCard>
            </div>
        </PageComponentLayout>
    );
}

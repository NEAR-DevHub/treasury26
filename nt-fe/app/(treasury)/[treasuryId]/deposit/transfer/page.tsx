"use client";

import { Clock, Link2, Zap } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { formatBalance } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { DepositAddressCard } from "../../dashboard/components/deposit/deposit-address-card";
import { DepositConfidentialSourceTabs } from "../../dashboard/components/deposit/deposit-confidential-source-tabs";
import { DepositNoticeList } from "../../dashboard/components/deposit/deposit-notice-list";
import {
    buildConfidentialOriginNotices,
    buildPublicTreasuryNotices,
    buildPublicWalletOneTimeNotices,
} from "../../dashboard/components/deposit/deposit-notices";
import { DepositPayTreasuryModal } from "../../dashboard/components/deposit/deposit-pay-treasury-modal";
import {
    resolvePayWithTrezuNextStep,
    resolveSendTokenMeta,
} from "../../dashboard/components/deposit/deposit-transfer-resolve";
import { DepositTransferSummary } from "../../dashboard/components/deposit/deposit-transfer-summary";
import {
    buildPayWithTrezuPaymentsPath,
    CHOOSE_PAYER_QUERY,
    getAbsoluteTransferUrl,
    parseTransferType,
    withChoosePayerParam,
    withoutChoosePayerParam,
} from "../../dashboard/components/deposit/deposit-transfer-url";
import type { ConfidentialOrigin } from "../../dashboard/components/deposit/deposit-types";

export default function DepositTransferPage() {
    const t = useTranslations("depositModal");
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { accountId, isInitializing } = useNear();
    const { treasuryId, config, treasuries, isConfidential, isLoading } =
        useTreasury();
    const resumedChoosePayerRef = useRef(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    const tokenId = searchParams.get("token") || "";
    const networkId = searchParams.get("network") || "";
    const addressParam = searchParams.get("address") || "";
    const shouldOpenPicker = searchParams.get(CHOOSE_PAYER_QUERY) === "1";
    const type = parseTransferType(searchParams.get("type"), {
        hasPublicParams: Boolean(addressParam && (tokenId || networkId)),
    });
    // Drives Trezu vs near.com notice copy; kept in the URL for share/copy link.
    const confidentialOrigin: ConfidentialOrigin =
        searchParams.get("source") === "nearcom" ? "nearcom" : "trezu";

    const hasShareParams =
        searchParams.has("type") ||
        searchParams.has("address") ||
        searchParams.has("token") ||
        searchParams.has("network") ||
        searchParams.has("source");

    // Public shares must carry the bridge deposit address — never fall back to dao id.
    const isPublicShareIncomplete =
        type === "public" && (!addressParam || !networkId);

    const setConfidentialOrigin = useCallback(
        (origin: ConfidentialOrigin) => {
            if (type !== "confidential") return;
            const params = new URLSearchParams(searchParams.toString());
            params.set("source", origin);
            const next = params.toString();
            router.replace(`${pathname}${next ? `?${next}` : ""}`, {
                scroll: false,
            });
        },
        [type, searchParams, pathname, router],
    );

    // Bare / incomplete transfer URLs → main deposit (no flash of wrong address).
    useEffect(() => {
        if (!treasuryId) return;
        if (!hasShareParams || isPublicShareIncomplete) {
            router.replace(`/${treasuryId}/dashboard/deposit`);
        }
    }, [treasuryId, hasShareParams, isPublicShareIncomplete, router]);

    // Destination treasury is always the dao id from the path; name comes from DB.
    const recipientDaoId = treasuryId || "";
    const depositAddress =
        type === "confidential" ? recipientDaoId : addressParam;
    const treasuryDisplayName = config?.name || recipientDaoId;

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

    const paymentPrefill = useMemo(() => {
        if (type === "public") {
            if (!depositAddress || !networkId) return null;
            return { address: depositAddress, networks: networkId };
        }
        if (!recipientDaoId) return null;
        return { address: recipientDaoId, networks: NEAR_COM_NETWORK_ID };
    }, [type, depositAddress, networkId, recipientDaoId]);

    const stripChoosePayerParam = useCallback(() => {
        if (!shouldOpenPicker) return;
        const next = withoutChoosePayerParam(
            `${pathname}?${searchParams.toString()}`,
        );
        router.replace(next, { scroll: false });
    }, [shouldOpenPicker, searchParams, pathname, router]);

    const continuePayWithTrezu = useCallback(() => {
        if (!paymentPrefill) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }

        const next = resolvePayWithTrezuNextStep(treasuries, recipientDaoId);
        if (next.kind === "create") {
            stripChoosePayerParam();
            router.push("/create");
            return;
        }
        if (next.kind === "pay") {
            stripChoosePayerParam();
            router.push(
                buildPayWithTrezuPaymentsPath(
                    next.payerTreasuryId,
                    paymentPrefill,
                ),
            );
            return;
        }
        setPickerOpen(true);
    }, [
        paymentPrefill,
        treasuries,
        recipientDaoId,
        router,
        t,
        stripChoosePayerParam,
    ]);

    const payWithTrezuStep = useMemo(() => {
        if (!accountId || isInitializing || isLoading) return null;
        return resolvePayWithTrezuNextStep(treasuries, recipientDaoId);
    }, [accountId, isInitializing, isLoading, treasuries, recipientDaoId]);

    // Keep chooser tied to `?choosePayer=1` so remounts after login still show it.
    const showPicker =
        pickerOpen ||
        (shouldOpenPicker &&
            !!paymentPrefill &&
            payWithTrezuStep?.kind === "choose");

    // After login (`?choosePayer=1`): create / pay when no chooser is needed.
    useEffect(() => {
        if (!shouldOpenPicker || isInitializing || isLoading) return;
        if (!accountId || resumedChoosePayerRef.current) return;
        if (!paymentPrefill || !payWithTrezuStep) return;
        if (payWithTrezuStep.kind === "choose") return;

        resumedChoosePayerRef.current = true;
        continuePayWithTrezu();
    }, [
        shouldOpenPicker,
        accountId,
        isInitializing,
        isLoading,
        paymentPrefill,
        payWithTrezuStep,
        continuePayWithTrezu,
    ]);

    const handleCopyLink = async () => {
        const sharePath = withoutChoosePayerParam(
            `${pathname}?${searchParams.toString()}`,
        );
        const url = getAbsoluteTransferUrl(sharePath);
        try {
            await navigator.clipboard.writeText(url);
            toast.success(t("linkCopied"));
        } catch {
            toast.error(t("errors.fetchFailed"));
        }
    };

    const handlePayWithTrezu = () => {
        if (!paymentPrefill) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }

        if (!accountId) {
            const returnTo = withChoosePayerParam(
                withoutChoosePayerParam(
                    `${pathname}?${searchParams.toString()}`,
                ),
            );
            router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
            return;
        }

        if (isLoading) return;
        continuePayWithTrezu();
    };

    const handlePickerOpenChange = (open: boolean) => {
        setPickerOpen(open);
        if (!open) stripChoosePayerParam();
    };

    const handleSelectPayerTreasury = (payerTreasuryId: string) => {
        if (!paymentPrefill) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }
        setPickerOpen(false);
        stripChoosePayerParam();
        router.push(
            buildPayWithTrezuPaymentsPath(payerTreasuryId, paymentPrefill),
        );
    };

    const pageTitle =
        type === "confidential" || isConfidential
            ? t("transfer.titleConfidential")
            : t("transfer.title");

    if (!hasShareParams || isPublicShareIncomplete) {
        return null;
    }

    return (
        <PageComponentLayout title={pageTitle}>
            <div className="flex justify-center w-full">
                <PageCard className="w-full max-w-150 gap-4">
                    <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3 pb-3 border-b border-general-border mb-3">
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

            <DepositPayTreasuryModal
                open={showPicker}
                onOpenChange={handlePickerOpenChange}
                treasuries={treasuries}
                excludeTreasuryId={recipientDaoId}
                isLoading={Boolean(accountId) && isLoading}
                onSelect={handleSelectPayerTreasury}
            />
        </PageComponentLayout>
    );
}

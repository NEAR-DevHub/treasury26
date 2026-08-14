"use client";

import { Clock, Link2, Zap } from "lucide-react";
import Link from "next/link";
import {
    useParams,
    usePathname,
    useRouter,
    useSearchParams,
} from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import Logo from "@/components/icons/logo";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { NEAR_COM_ICON } from "@/constants/token";
import { withNearComAddressPrefix } from "@/lib/nearcom-address";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useConfidentialBridgeAddress } from "@/hooks/use-confidential-bridge-address";
import { useDepositAddressStatus } from "@/hooks/use-deposit-address-status";
import { useDepositExpiryClock } from "@/hooks/use-deposit-expiry-clock";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { DepositAddressCard } from "../../dashboard/components/deposit/deposit-address-card";
import { DepositAddressSkeleton } from "../../dashboard/components/deposit/deposit-address-view";
import { DepositConfidentialSourceTabs } from "../../dashboard/components/deposit/deposit-confidential-source-tabs";
import { isDepositAddressUsed } from "../../dashboard/components/deposit/deposit-expires";
import { DepositNoticeList } from "../../dashboard/components/deposit/deposit-notice-list";
import {
    buildConfidentialOriginNotices,
    buildPublicTreasuryNotices,
    buildPublicWalletOneTimeNotices,
} from "../../dashboard/components/deposit/deposit-notices";
import { DepositPayTreasuryModal } from "../../dashboard/components/deposit/deposit-pay-treasury-modal";
import { DepositTransferInactive } from "../../dashboard/components/deposit/deposit-transfer-inactive";
import {
    resolveBridgeChainId,
    resolvePayWithTrezuNextStep,
    resolveSendTokenMeta,
} from "../../dashboard/components/deposit/deposit-transfer-resolve";
import { DepositTransferSummary } from "../../dashboard/components/deposit/deposit-transfer-summary";
import {
    buildPaymentsDeepLink,
    CHOOSE_PAYER_QUERY,
    getAbsoluteTransferUrl,
    parsePayShareKind,
    withChoosePayerParam,
    withoutChoosePayerParam,
} from "../../dashboard/components/deposit/deposit-transfer-url";
import type { ConfidentialOrigin } from "../../dashboard/components/deposit/deposit-types";
import { formatMinDepositDisplay } from "../../dashboard/components/deposit/format-min-deposit";

export default function PaySharePage() {
    const t = useTranslations("depositModal");
    const locale = useLocale();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const params = useParams<{ kind?: string }>();
    const { accountId, isInitializing } = useNear();
    const { treasuryId, config, treasuries, isConfidential, isLoading } =
        useTreasury();
    const resumedChoosePayerRef = useRef(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    const kind = parsePayShareKind(params.kind);
    const shareId = searchParams.get("id") || "";
    const tokenId = searchParams.get("token") || "";
    const networkFromUrl = searchParams.get("network") || "";
    const shouldOpenPicker = searchParams.get(CHOOSE_PAYER_QUERY) === "1";
    const confidentialOrigin: ConfidentialOrigin =
        searchParams.get("source") === "nearcom" ? "nearcom" : "trezu";

    const isOneTimeConfidentialShare = kind === "public" && isConfidential;
    const isPublicTreasuryShare = kind === "public" && !isConfidential;

    const {
        hasFetched: hasFetchedStatus,
        found: statusFound,
        status: depositStatus,
        expiresAtMs: statusExpiresAtMs,
        originAsset: statusOriginAsset,
        isTerminal: statusIsTerminal,
    } = useDepositAddressStatus({
        enabled: isOneTimeConfidentialShare,
        accountId: treasuryId,
        depositAddress: shareId,
    });

    const networkId = isOneTimeConfidentialShare
        ? statusOriginAsset || ""
        : networkFromUrl;

    const isShareIncomplete =
        !kind ||
        (kind === "public" &&
            (!shareId ||
                (isPublicTreasuryShare && !isLoading && !networkFromUrl)));

    const setConfidentialOrigin = useCallback(
        (origin: ConfidentialOrigin) => {
            if (kind !== "confidential") return;
            const next = new URLSearchParams(searchParams.toString());
            next.set("source", origin);
            const qs = next.toString();
            router.replace(`${pathname}${qs ? `?${qs}` : ""}`, {
                scroll: false,
            });
        },
        [kind, searchParams, pathname, router],
    );

    useEffect(() => {
        if (!treasuryId) return;
        if (isShareIncomplete) {
            router.replace(`/${treasuryId}/dashboard/deposit`);
        }
    }, [treasuryId, isShareIncomplete, router]);

    const recipientDaoId = treasuryId || "";
    const treasuryDisplayName = config?.name || recipientDaoId;

    const { data: bridgeAssets = [] } = useBridgeTokens(kind === "public");

    const bridgeChainId = useMemo(() => {
        if (!networkId) return null;
        return resolveBridgeChainId(bridgeAssets, networkId) || networkId;
    }, [bridgeAssets, networkId]);

    const shouldFetchBridge =
        isOneTimeConfidentialShare &&
        hasFetchedStatus &&
        statusFound === true &&
        !statusIsTerminal &&
        !!shareId &&
        !!bridgeChainId;

    const {
        address: bridgeAddress,
        memo: bridgeMemo,
        hasFetched: bridgeQueryFetched,
    } = useConfidentialBridgeAddress({
        enabled: shouldFetchBridge,
        quoteDepositAddress: shareId,
        bridgeChainId,
    });

    // Settle when status says skip bridge, chain is missing, or the query finished.
    const hasFetchedBridge = !hasFetchedStatus
        ? false
        : statusFound !== true || statusIsTerminal || !bridgeChainId
          ? true
          : bridgeQueryFetched;

    const nowMs = useDepositExpiryClock(
        isOneTimeConfidentialShare && !statusIsTerminal,
        statusExpiresAtMs,
    );

    const isStatusLoading =
        kind === "public" &&
        (isLoading ||
            (isConfidential &&
                (!hasFetchedStatus ||
                    (statusFound === true &&
                        !statusIsTerminal &&
                        !hasFetchedBridge))));

    const isUsed = isDepositAddressUsed(depositStatus);
    const isInactive =
        !isStatusLoading && isOneTimeConfidentialShare && statusIsTerminal;

    const depositAddress =
        kind === "confidential"
            ? withNearComAddressPrefix(recipientDaoId)
            : isOneTimeConfidentialShare
              ? bridgeAddress || ""
              : shareId;

    const sendTokenMeta = useMemo(
        () =>
            kind === "public"
                ? resolveSendTokenMeta(bridgeAssets, tokenId, networkId)
                : null,
        [kind, bridgeAssets, tokenId, networkId],
    );

    const minDepositDisplay = useMemo(
        () =>
            formatMinDepositDisplay(
                sendTokenMeta?.minDepositAmount,
                sendTokenMeta?.decimals ?? 0,
            ),
        [sendTokenMeta?.minDepositAmount, sendTokenMeta?.decimals],
    );

    const notices = useMemo(() => {
        if (kind === "confidential") {
            return buildConfidentialOriginNotices(t, confidentialOrigin);
        }

        const symbol = sendTokenMeta?.symbol || tokenId;
        const network = sendTokenMeta?.networkName || networkId;

        if (!isConfidential) {
            return buildPublicTreasuryNotices(
                t,
                network,
                minDepositDisplay,
                symbol,
            );
        }

        return buildPublicWalletOneTimeNotices(t, symbol, network, {
            expiresAtMs: statusExpiresAtMs,
            nowMs,
            locale,
        });
    }, [
        kind,
        isConfidential,
        confidentialOrigin,
        sendTokenMeta?.symbol,
        sendTokenMeta?.networkName,
        minDepositDisplay,
        tokenId,
        networkId,
        statusExpiresAtMs,
        nowMs,
        locale,
        t,
    ]);

    const isConfidentialShare = kind === "confidential";
    const isConfidentialNearcomShare =
        isConfidentialShare && confidentialOrigin === "nearcom";

    const paymentPrefill = useMemo(() => {
        // near.com CTA opens near.com/home — no Trezu payments prefill.
        if (isConfidentialNearcomShare) return null;
        if (kind === "public") {
            // Exact ids for payments matching — not display names or JSON blobs.
            if (
                !depositAddress ||
                !sendTokenMeta?.assetId ||
                !sendTokenMeta?.networkId
            ) {
                return null;
            }
            return {
                address: depositAddress,
                token: sendTokenMeta.assetId,
                network: sendTokenMeta.networkId,
            };
        }
        if (!recipientDaoId) return null;
        // Confidential Trezu pays via near.com into the nearcom:-prefixed DAO id.
        return {
            address: withNearComAddressPrefix(recipientDaoId),
            networks: NEAR_COM_NETWORK_ID,
        };
    }, [
        isConfidentialNearcomShare,
        kind,
        depositAddress,
        sendTokenMeta,
        recipientDaoId,
    ]);

    const payWithTrezuFilter = useMemo(
        () => ({
            destinationTreasuryId: recipientDaoId,
            confidentialOnly:
                isConfidentialShare && !isConfidentialNearcomShare,
        }),
        [recipientDaoId, isConfidentialShare, isConfidentialNearcomShare],
    );

    const currentSharePath = withoutChoosePayerParam(
        `${pathname}?${searchParams.toString()}`,
    );

    const stripChoosePayerParam = useCallback(() => {
        if (!shouldOpenPicker) return;
        router.replace(currentSharePath, { scroll: false });
    }, [shouldOpenPicker, currentSharePath, router]);

    const goToPayerTreasury = useCallback(
        (payerTreasuryId: string) => {
            if (!paymentPrefill) {
                toast.error(t("transfer.payRequiresTreasury"));
                return;
            }
            stripChoosePayerParam();
            router.push(buildPaymentsDeepLink(payerTreasuryId, paymentPrefill));
        },
        [paymentPrefill, stripChoosePayerParam, router, t],
    );

    const continuePayWithTrezu = useCallback(() => {
        if (!paymentPrefill) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }

        const next = resolvePayWithTrezuNextStep(
            treasuries,
            payWithTrezuFilter,
        );
        if (next.kind === "create") {
            stripChoosePayerParam();
            router.push("/create");
            return;
        }
        if (next.kind === "pay") {
            goToPayerTreasury(next.payerTreasuryId);
            return;
        }
        setPickerOpen(true);
    }, [
        paymentPrefill,
        treasuries,
        payWithTrezuFilter,
        router,
        t,
        stripChoosePayerParam,
        goToPayerTreasury,
    ]);

    const payWithTrezuStep = useMemo(() => {
        if (!accountId || isInitializing || isLoading) return null;
        return resolvePayWithTrezuNextStep(treasuries, payWithTrezuFilter);
    }, [accountId, isInitializing, isLoading, treasuries, payWithTrezuFilter]);

    const showPicker =
        pickerOpen ||
        (shouldOpenPicker &&
            !!paymentPrefill &&
            payWithTrezuStep?.kind === "choose");

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
        const url = getAbsoluteTransferUrl(currentSharePath);
        try {
            await navigator.clipboard.writeText(url);
            toast.success(t("linkCopied"));
        } catch {
            toast.error(t("errors.fetchFailed"));
        }
    };

    const handlePayWithNearcom = () => {
        window.open("https://near.com/send", "_blank", "noopener,noreferrer");
    };

    const handlePayWithTrezu = () => {
        if (!paymentPrefill) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }

        if (!accountId) {
            const returnTo = withChoosePayerParam(currentSharePath);
            router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
            return;
        }

        if (isLoading) return;
        continuePayWithTrezu();
    };

    const handlePayCta = () => {
        if (isConfidentialNearcomShare) {
            handlePayWithNearcom();
            return;
        }
        handlePayWithTrezu();
    };

    const handlePickerOpenChange = (open: boolean) => {
        setPickerOpen(open);
        if (!open) stripChoosePayerParam();
    };

    const handleSelectPayerTreasury = (payerTreasuryId: string) => {
        setPickerOpen(false);
        goToPayerTreasury(payerTreasuryId);
    };

    const pageTitle =
        kind === "confidential" || isConfidential
            ? t("transfer.titleConfidential")
            : t("transfer.title");

    if (isShareIncomplete) {
        return null;
    }

    const inactiveBadge = isUsed ? t("transfer.used") : t("transfer.expired");

    return (
        <PageComponentLayout
            title={pageTitle}
            hideCollapseButton
            hideAppWarningBanner
            logo={
                <Link href="/">
                    <Logo size="sm" />
                </Link>
            }
        >
            <div className="flex justify-center w-full md:mt-4">
                <PageCard className="w-full max-w-150 gap-4">
                    {isStatusLoading ? (
                        <div data-testid="deposit-transfer-status-skeleton">
                            <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3 pb-3 border-b border-general-border mb-3">
                                <Skeleton className="h-7 w-56" />
                                <Skeleton className="h-6 w-36 rounded-full" />
                            </div>
                            <DepositAddressSkeleton />
                            <div className="space-y-2 mt-4">
                                <Skeleton className="h-10 w-full rounded-xl" />
                                <Skeleton className="h-10 w-full rounded-xl" />
                            </div>
                        </div>
                    ) : isInactive ? (
                        <DepositTransferInactive
                            pageTitle={pageTitle}
                            badgeLabel={inactiveBadge}
                        />
                    ) : (
                        <>
                            <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3 pb-3 border-b border-general-border mb-3">
                                <h1 className="font-semibold text-lg leading-snug">
                                    {pageTitle}
                                </h1>
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-general-orange-background-faded text-general-orange-foreground px-2.5 py-1 text-xs font-medium shrink-0">
                                    <Clock className="size-3.5" />
                                    {t("transfer.waitingForPayment")}
                                </span>
                            </div>

                            {kind === "confidential" && (
                                <DepositConfidentialSourceTabs
                                    value={confidentialOrigin}
                                    onChange={setConfidentialOrigin}
                                />
                            )}

                            <DepositTransferSummary
                                variant={
                                    kind === "public"
                                        ? "public"
                                        : "confidential"
                                }
                                sendTokenMeta={sendTokenMeta}
                                tokenId={tokenId}
                                networkId={networkId}
                                treasuryDisplayName={treasuryDisplayName}
                                treasuryLogo={config?.metadata?.flagLogo}
                                isConfidentialTreasury={isConfidential}
                            />

                            <DepositAddressCard
                                address={depositAddress}
                                memo={bridgeMemo}
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
                                    onClick={handlePayCta}
                                    className="w-full gap-2"
                                    data-testid={
                                        isConfidentialNearcomShare
                                            ? "deposit-pay-with-nearcom"
                                            : "deposit-pay-with-trezu"
                                    }
                                >
                                    {isConfidentialNearcomShare ? (
                                        <img
                                            src={NEAR_COM_ICON}
                                            alt=""
                                            className="size-4 rounded"
                                        />
                                    ) : (
                                        <Zap className="size-4 fill-current" />
                                    )}
                                    {isConfidentialNearcomShare
                                        ? t("transfer.payWithNearcom")
                                        : t("transfer.payWithTrezu")}
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
                        </>
                    )}
                </PageCard>
            </div>

            {!isInactive && !isConfidentialNearcomShare && (
                <DepositPayTreasuryModal
                    open={showPicker}
                    onOpenChange={handlePickerOpenChange}
                    treasuries={treasuries}
                    excludeTreasuryId={recipientDaoId}
                    confidentialOnly={isConfidentialShare}
                    isLoading={Boolean(accountId) && isLoading}
                    onSelect={handleSelectPayerTreasury}
                />
            )}
        </PageComponentLayout>
    );
}

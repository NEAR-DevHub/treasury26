"use client";

import { Clock } from "lucide-react";
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
import { CopyButton } from "@/components/copy-button";
import Logo from "@/components/icons/logo";
import { NearBusinessLogo } from "@/components/icons/near-business-logo";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { buildLoginHref } from "@/lib/auth-redirect";
import { withNearComAddressPrefix } from "@/lib/nearcom-address";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useConfidentialBridgeAddress } from "@/hooks/use-confidential-bridge-address";
import { useDepositAddressStatus } from "@/hooks/use-deposit-address-status";
import { useDepositExpiryClock } from "@/hooks/use-deposit-expiry-clock";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { DepositAddressCard } from "../../dashboard/components/deposit/deposit-address-card";
import { DepositAddressSkeleton } from "../../dashboard/components/deposit/deposit-address-view";
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
    type PaymentsDeepLinkParams,
    withChoosePayerParam,
    withoutChoosePayerParam,
} from "../../dashboard/components/deposit/deposit-transfer-url";
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
            return buildConfidentialOriginNotices(t);
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

    // Prefills Trezu `/payments` (see payments/page.tsx):
    // - reusable confidential: bare dao `address` + soft `networks=near.com`
    //   (payments locks destination via prefersNearCom → nearChainDestination(true))
    // - public / one-time: `address` + exact `token` + `network`
    const paymentPrefill = useMemo((): PaymentsDeepLinkParams | null => {
        if (kind === "confidential") {
            if (!recipientDaoId) return null;
            return {
                address: recipientDaoId,
                networks: NEAR_COM_NETWORK_ID,
            };
        }
        if (kind === "public") {
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
        return null;
    }, [kind, recipientDaoId, depositAddress, sendTokenMeta]);

    const payWithTrezuFilter = useMemo(
        () => ({
            destinationTreasuryId: recipientDaoId,
            confidentialOnly: isConfidentialShare,
        }),
        [recipientDaoId, isConfidentialShare],
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

    const handlePayCta = () => {
        if (!paymentPrefill) {
            toast.error(t("transfer.payRequiresTreasury"));
            return;
        }

        if (!accountId) {
            router.push(
                buildLoginHref(withChoosePayerParam(currentSharePath), ""),
            );
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
            hideHeader
            hideCollapseButton
            hideAppWarningBanner
        >
            <div className="flex justify-center w-full mt-8 md:mt-20">
                <div className="flex w-full max-w-[700px] flex-col gap-5 lg:gap-4">
                    <Link href="/" className="w-fit">
                        {isConfidential ? (
                            <NearBusinessLogo className="h-7 w-auto" />
                        ) : (
                            <Logo size="sm" />
                        )}
                    </Link>

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
                            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 mt-4 sm:mt-8 sm:mb-5">
                                <h1 className="text-2xl font-bold leading-[120%] text-foreground">
                                    {pageTitle}
                                </h1>
                                <span className="inline-flex items-center gap-1.5 shrink-0 rounded-full border border-solid border-general-orange-border bg-general-orange-background-faded px-2.5 py-1 text-xs font-medium text-general-orange-foreground">
                                    <Clock className="size-3.5" />
                                    {t("transfer.waitingForPayment")}
                                </span>
                            </div>

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
                                    <div className="px-3 py-3">
                                        <DepositNoticeList notices={notices} />
                                    </div>
                                }
                            />

                            <div className="space-y-2 mt-4">
                                <Button
                                    type="button"
                                    onClick={handlePayCta}
                                    disabled={!paymentPrefill}
                                    className="h-11 w-full gap-2 rounded-2xl text-base font-bold leading-4 text-primary-foreground"
                                    data-testid={
                                        isConfidential
                                            ? "deposit-pay-with-near-business"
                                            : "deposit-pay-with-trezu"
                                    }
                                >
                                    {isConfidential
                                        ? t("transfer.payWithNearcom")
                                        : t("transfer.payWithTrezu")}
                                </Button>
                                <CopyButton
                                    text={getAbsoluteTransferUrl(
                                        currentSharePath,
                                    )}
                                    variant="secondary"
                                    className="h-11 w-full gap-2 rounded-2xl bg-general-bg-secondary text-base font-bold leading-4 text-muted-foreground hover:bg-general-bg-secondary/80"
                                    data-testid="deposit-copy-link"
                                >
                                    {t("transfer.copyLink")}
                                </CopyButton>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {!isInactive && (
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

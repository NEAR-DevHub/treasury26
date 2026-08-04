"use client";

import { Clock, Link2, Zap } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import Logo from "@/components/icons/logo";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import {
    fetchDepositAddress,
    fetchDepositAddressStatus,
} from "@/lib/bridge-api";
import { formatBalance } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { DepositAddressCard } from "../../dashboard/components/deposit/deposit-address-card";
import { DepositAddressSkeleton } from "../../dashboard/components/deposit/deposit-address-view";
import { DepositConfidentialSourceTabs } from "../../dashboard/components/deposit/deposit-confidential-source-tabs";
import {
    isDepositAddressExpired,
    isDepositAddressUsed,
} from "../../dashboard/components/deposit/deposit-expires";
import { DepositNoticeList } from "../../dashboard/components/deposit/deposit-notice-list";
import {
    buildConfidentialOriginNotices,
    buildPublicTreasuryNotices,
    buildPublicWalletOneTimeNotices,
} from "../../dashboard/components/deposit/deposit-notices";
import { DepositPayTreasuryModal } from "../../dashboard/components/deposit/deposit-pay-treasury-modal";
import {
    resolveBridgeChainId,
    resolvePayWithTrezuNextStep,
    resolveSendTokenMeta,
} from "../../dashboard/components/deposit/deposit-transfer-resolve";
import { DepositTransferInactive } from "../../dashboard/components/deposit/deposit-transfer-inactive";
import { DepositTransferSummary } from "../../dashboard/components/deposit/deposit-transfer-summary";
import {
    buildPayWithTrezuPaymentsPath,
    CHOOSE_PAYER_QUERY,
    getAbsoluteTransferUrl,
    parsePayShareKind,
    withChoosePayerParam,
    withoutChoosePayerParam,
} from "../../dashboard/components/deposit/deposit-transfer-url";
import type { ConfidentialOrigin } from "../../dashboard/components/deposit/deposit-types";

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
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [depositStatus, setDepositStatus] = useState<string | null>(null);
    const [statusExpiresAtMs, setStatusExpiresAtMs] = useState<number | null>(
        null,
    );
    const [statusOriginAsset, setStatusOriginAsset] = useState<string | null>(
        null,
    );
    const [statusFound, setStatusFound] = useState<boolean | null>(null);
    const [hasFetchedStatus, setHasFetchedStatus] = useState(false);
    const [bridgeAddress, setBridgeAddress] = useState<string | null>(null);
    const [bridgeMemo, setBridgeMemo] = useState<string | null>(null);
    const [hasFetchedBridge, setHasFetchedBridge] = useState(false);

    const kind = parsePayShareKind(params.kind);
    const shareId = searchParams.get("id") || "";
    const tokenId = searchParams.get("token") || "";
    const networkFromUrl = searchParams.get("network") || "";
    const shouldOpenPicker = searchParams.get(CHOOSE_PAYER_QUERY) === "1";
    const confidentialOrigin: ConfidentialOrigin =
        searchParams.get("source") === "nearcom" ? "nearcom" : "trezu";

    const isOneTimeConfidentialShare = kind === "public" && isConfidential;
    const isPublicTreasuryShare = kind === "public" && !isConfidential;

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

    const { data: bridgeAssets = [] } = useBridgeTokens(kind === "public", {
        includeNearNetwork: true,
    });

    // Status for confidential one-time shares (asset + expiry + used).
    useEffect(() => {
        if (!isOneTimeConfidentialShare || !treasuryId || !shareId) {
            setDepositStatus(null);
            setStatusExpiresAtMs(null);
            setStatusOriginAsset(null);
            setStatusFound(null);
            setHasFetchedStatus(false);
            return;
        }

        let cancelled = false;
        setHasFetchedStatus(false);

        const poll = async () => {
            try {
                const result = await fetchDepositAddressStatus(
                    treasuryId,
                    shareId,
                );
                if (cancelled) return;
                setStatusFound(result.found);
                setDepositStatus(result.status ?? null);
                setStatusOriginAsset(
                    result.originAsset || result.destinationAsset || null,
                );
                const expiresMs = result.expiresAt
                    ? Date.parse(result.expiresAt)
                    : Number.NaN;
                setStatusExpiresAtMs(
                    Number.isFinite(expiresMs) ? expiresMs : null,
                );
            } catch {
                if (!cancelled) {
                    setStatusFound(false);
                    setDepositStatus(null);
                    setStatusExpiresAtMs(null);
                    setStatusOriginAsset(null);
                }
            } finally {
                if (!cancelled) setHasFetchedStatus(true);
            }
        };

        void poll();
        const id = window.setInterval(poll, 15_000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [isOneTimeConfidentialShare, treasuryId, shareId]);

    // Bridge address from quote id + chain (after status provides the asset).
    useEffect(() => {
        if (!isOneTimeConfidentialShare) {
            setBridgeAddress(null);
            setBridgeMemo(null);
            setHasFetchedBridge(false);
            return;
        }
        if (!hasFetchedStatus || !statusFound || !networkId || !shareId) {
            setBridgeAddress(null);
            setBridgeMemo(null);
            setHasFetchedBridge(
                hasFetchedStatus && (statusFound === false || !networkId),
            );
            return;
        }

        const chain =
            resolveBridgeChainId(bridgeAssets, networkId) || networkId;
        let cancelled = false;
        setHasFetchedBridge(false);

        // Quote id is not a confidential DAO, so POST deposit-address only
        // runs the bridge lookup (no new confidential quote).
        void (async () => {
            try {
                const result = await fetchDepositAddress(shareId, chain);
                if (cancelled) return;
                setBridgeAddress(result?.address ?? null);
                setBridgeMemo(result?.memo ?? null);
            } catch {
                if (!cancelled) {
                    setBridgeAddress(null);
                    setBridgeMemo(null);
                }
            } finally {
                if (!cancelled) setHasFetchedBridge(true);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        isOneTimeConfidentialShare,
        hasFetchedStatus,
        statusFound,
        networkId,
        shareId,
        bridgeAssets,
    ]);

    const expiresAtMs = statusExpiresAtMs;

    useEffect(() => {
        if (!isOneTimeConfidentialShare || expiresAtMs == null) return;
        setNowMs(Date.now());
        const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
        return () => window.clearInterval(id);
    }, [isOneTimeConfidentialShare, expiresAtMs]);

    const isStatusLoading =
        kind === "public" &&
        (isLoading ||
            (isConfidential &&
                (!hasFetchedStatus ||
                    (statusFound === true && !hasFetchedBridge))));

    const isUsed = isDepositAddressUsed(depositStatus);
    const isExpired = isDepositAddressExpired(expiresAtMs, nowMs);
    const isInactive =
        !isStatusLoading &&
        isOneTimeConfidentialShare &&
        (statusFound === false || isUsed || isExpired);

    const depositAddress =
        kind === "confidential"
            ? recipientDaoId
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

    const minDepositDisplay = useMemo(() => {
        if (!sendTokenMeta?.minDepositAmount) return null;
        return formatBalance(
            sendTokenMeta.minDepositAmount,
            sendTokenMeta.decimals,
        );
    }, [sendTokenMeta?.minDepositAmount, sendTokenMeta?.decimals]);

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
            expiresAtMs,
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
        expiresAtMs,
        nowMs,
        locale,
        t,
    ]);

    const paymentPrefill = useMemo(() => {
        if (kind === "public") {
            if (!depositAddress || !networkId) return null;
            return { address: depositAddress, networks: networkId };
        }
        if (!recipientDaoId) return null;
        return { address: recipientDaoId, networks: NEAR_COM_NETWORK_ID };
    }, [kind, depositAddress, networkId, recipientDaoId]);

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
                        </>
                    )}
                </PageCard>
            </div>

            {!isInactive && (
                <DepositPayTreasuryModal
                    open={showPicker}
                    onOpenChange={handlePickerOpenChange}
                    treasuries={treasuries}
                    excludeTreasuryId={recipientDaoId}
                    isLoading={Boolean(accountId) && isLoading}
                    onSelect={handleSelectPayerTreasury}
                />
            )}
        </PageComponentLayout>
    );
}

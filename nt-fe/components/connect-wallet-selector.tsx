"use client";

import { Check, Fingerprint, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { SlotWarning } from "@/components/warning-message";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { StepperHeader } from "@/components/step-wizard";
import { Pill } from "@/components/pill";
import {
    useWarningOfflineBadgeLabel,
    useResolveWarningMessage,
} from "@/hooks/use-warnings";
import { useWarnings } from "@/hooks/use-warnings";
import { trackEvent } from "@/lib/analytics";
import {
    LAST_USED_WALLET_STORAGE_KEY,
    NEAR_WALLET_CHOICES,
    SELECTED_WALLET_STORAGE_KEY,
    WALLET_IDS,
    WALLET_OPTIONS,
    type WalletOption,
    getWalletGroup,
    getWalletLoginSlot,
    resolveManifestWalletId,
} from "@/lib/wallets";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

type WalletPickerType = "near";

function WalletOptionIcon({
    wallet,
    size = "lg",
}: {
    wallet: WalletOption;
    size?: "lg" | "xl";
}) {
    const sizeClass = size === "xl" ? "size-12" : "size-8";
    if (wallet.id === WALLET_IDS.PASSKEY) {
        return (
            <div className="flex items-center">
                <div
                    className={cn(
                        `${sizeClass} rounded-full bg-foreground text-background flex items-center justify-center`,
                        wallet.imageClassName,
                    )}
                >
                    <Fingerprint className="size-4" />
                </div>
            </div>
        );
    }

    const stackedSources = [
        wallet.tertiaryIconSrc,
        wallet.secondaryIconSrc,
        wallet.imgSrc,
    ].filter(Boolean) as string[];

    return (
        <div className="flex items-center">
            {stackedSources.map((src, index) => (
                <img
                    key={`${wallet.id}-${src}-${index}`}
                    src={src}
                    alt={
                        index === stackedSources.length - 1 ? wallet.label : ""
                    }
                    className={cn(
                        `${sizeClass} rounded-full bg-black object-cover`,
                        stackedSources.length > 1 && "border-2 border-card",
                        index > 0 && "-ml-3",
                        index === stackedSources.length - 1
                            ? "relative z-30"
                            : index === stackedSources.length - 2
                              ? "relative z-20"
                              : "relative z-10",
                        wallet.imageClassName,
                    )}
                />
            ))}
        </div>
    );
}

interface ConnectWalletSelectorProps {
    source: string;
    connectFlow: "onboarding" | "within_treasury";
    isConnectingWallet?: boolean;
    onBack?: () => void;
    showBackButton?: boolean;
    showOnboardingHints?: boolean;
    showCreateTreasuryCta?: boolean;
    onCreateTreasuryClick?: () => void;
    onConnectSupported: (walletId?: string) => Promise<void> | void;
}

export function ConnectWalletSelector({
    source,
    connectFlow,
    isConnectingWallet = false,
    onBack,
    showBackButton = true,
    showOnboardingHints = false,
    showCreateTreasuryCta = true,
    onCreateTreasuryClick,
    onConnectSupported,
}: ConnectWalletSelectorProps) {
    const router = useRouter();
    const t = useTranslations("createTreasury");
    const { getWarning } = useWarnings();
    const resolveWarningMessage = useResolveWarningMessage();
    const offlineBadgeLabel = useWarningOfflineBadgeLabel();
    const { accountId, authError } = useNear();
    const [unsupportedWallet, setUnsupportedWallet] =
        useState<WalletOption | null>(null);
    const [isGuideOpen, setIsGuideOpen] = useState(false);
    const [walletPickerOpen, setWalletPickerOpen] =
        useState<WalletPickerType | null>(null);
    const [lastUsedWalletId, setLastUsedWalletId] = useState<string | null>(
        () => {
            if (typeof window === "undefined") return null;
            return (
                window.localStorage.getItem(LAST_USED_WALLET_STORAGE_KEY) ??
                window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY)
            );
        },
    );
    const [pendingRecentWalletId, setPendingRecentWalletId] = useState<
        string | null
    >(null);

    const closeUnsupportedWalletModal = () => {
        setUnsupportedWallet(null);
    };

    const headerTitle = t("walletSelector.title");
    const headerDescription = showOnboardingHints ? (
        <>
            {t("walletSelector.subtitle")}{" "}
            <button
                type="button"
                className="text-muted-foreground underline underline-offset-2 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm transition-colors cursor-pointer"
                onClick={() => setIsGuideOpen(true)}
            >
                {t("walletSelector.helpCta")}
            </button>
        </>
    ) : undefined;

    const recentWalletGroup = useMemo(
        () => getWalletGroup(lastUsedWalletId),
        [lastUsedWalletId],
    );

    const markWalletAsRecent = (walletId: string) => {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(LAST_USED_WALLET_STORAGE_KEY, walletId);
        setLastUsedWalletId(walletId);
    };

    // Persist "recent" only after login succeeds.
    useEffect(() => {
        if (!pendingRecentWalletId || !accountId) return;
        markWalletAsRecent(pendingRecentWalletId);
        setPendingRecentWalletId(null);
    }, [pendingRecentWalletId, accountId]);

    // Clear pending recent marker if login/auth fails.
    useEffect(() => {
        if (!pendingRecentWalletId || !authError) return;
        setPendingRecentWalletId(null);
    }, [pendingRecentWalletId, authError]);

    const isLoginPaused = getWarning("login")?.response === "paused";

    const isWalletChoiceBlocked = (walletId: WalletOption["id"]) => {
        if (isLoginPaused) return true;
        // The NEAR group is a container — it opens a modal whose inner choices
        // carry their own offline state, so the container itself isn't blocked.
        if (walletId === WALLET_IDS.NEAR) return false;
        const walletWarning = getWarning(getWalletLoginSlot(walletId));
        return walletWarning?.response === "paused";
    };

    // Per-wallet warning from the admin system. When present, the wallet
    // card shows an "Offline" badge (with the admin message as tooltip)
    // instead of "Recent".
    // Login wallet warnings are always paused (offline). Only surface those so
    // the "Offline" badge and the disabled state stay in lockstep.
    const getWalletWarning = (walletId: WalletOption["id"]) => {
        const warning = getWarning(getWalletLoginSlot(walletId));
        return warning?.response === "paused" ? warning : null;
    };

    type BadgeInfo = { label: string; tooltip?: string; isOffline?: boolean };

    // Show "Offline" badge only for per-wallet warnings, not when all
    // login is paused (the banner already covers that case).
    const getTopLevelBadge = (wallet: WalletOption): BadgeInfo | null => {
        // The NEAR group card opens a modal, so its inner choices show their own
        // "Offline" badges — don't tag the container itself.
        if (!isLoginPaused && wallet.id !== WALLET_IDS.NEAR) {
            const walletWarning = getWalletWarning(wallet.id);
            if (walletWarning) {
                const slot = getWalletLoginSlot(wallet.id);
                return {
                    label: offlineBadgeLabel,
                    tooltip:
                        resolveWarningMessage(walletWarning, slot) ?? undefined,
                    isOffline: true,
                };
            }
        }
        const hasRecent = !!lastUsedWalletId || !!recentWalletGroup;
        if (wallet.id === lastUsedWalletId || wallet.id === recentWalletGroup) {
            return { label: t("walletSelector.recentBadge") };
        }
        if (hasRecent) return null;
        return wallet.isPopular
            ? { label: t("walletSelector.popularBadge") }
            : null;
    };

    const getModalBadge = (wallet: WalletOption): BadgeInfo | null => {
        if (!isLoginPaused) {
            const walletWarning = getWalletWarning(wallet.id);
            if (walletWarning) {
                const slot = getWalletLoginSlot(wallet.id);
                return {
                    label: offlineBadgeLabel,
                    tooltip:
                        resolveWarningMessage(walletWarning, slot) ?? undefined,
                    isOffline: true,
                };
            }
        }
        if (wallet.id === lastUsedWalletId) {
            return { label: t("walletSelector.recentBadge") };
        }
        if (
            wallet.recentGroupAlias &&
            wallet.recentGroupAlias === recentWalletGroup
        ) {
            return { label: t("walletSelector.recentBadge") };
        }
        if (wallet.id === recentWalletGroup) {
            return { label: t("walletSelector.recentBadge") };
        }
        return wallet.isPopular
            ? { label: t("walletSelector.popularBadge") }
            : null;
    };

    const handleWalletChoice = (wallet: WalletOption) => {
        if (isWalletChoiceBlocked(wallet.id)) {
            return;
        }

        if (wallet.id === WALLET_IDS.NEAR) {
            setUnsupportedWallet(null);
            setIsGuideOpen(false);
            setWalletPickerOpen("near");
            return;
        }
        trackEvent("onboarding_wallet_option_clicked", {
            wallet_id: wallet.id,
            is_supported: wallet.supported,
            source,
            connect_flow: connectFlow,
        });

        if (wallet.supported) {
            setUnsupportedWallet(null);
            setIsGuideOpen(false);
            setWalletPickerOpen(null);
            setPendingRecentWalletId(wallet.id);
            const connectWalletId = resolveManifestWalletId(wallet.id);
            const maybeConnect = onConnectSupported(connectWalletId);
            Promise.resolve(maybeConnect).catch(() => {
                setPendingRecentWalletId(null);
            });
            return;
        }

        setUnsupportedWallet(wallet);
    };

    const walletPickerChoices = NEAR_WALLET_CHOICES;

    return (
        <>
            <PageCard>
                <StepperHeader
                    title={headerTitle}
                    description={headerDescription}
                    handleBack={showBackButton ? onBack : undefined}
                />
                <SlotWarning slot="login" className="mb-4" />
                {showOnboardingHints && (
                    <div className="space-y-3 mb-4">
                        <div className="flex items-start gap-2">
                            <div className="bg-general-success-background-faded rounded-full size-7 sm:size-6 flex items-center justify-center p-1 sm:p-0">
                                <Check className="size-4 shrink-0 text-general-success-foreground " />
                            </div>
                            <p className="text-sm mt-px">
                                {t("walletSelector.noFundsNote")}
                            </p>
                        </div>
                    </div>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {WALLET_OPTIONS.map((wallet) => (
                        <Button
                            key={wallet.id}
                            type="button"
                            variant="secondary"
                            className="h-26 items-start justify-start rounded-xl border border-border p-4 text-left hover:bg-muted"
                            onClick={() => handleWalletChoice(wallet)}
                            disabled={
                                isConnectingWallet ||
                                isWalletChoiceBlocked(wallet.id)
                            }
                        >
                            <div className="flex w-full flex-col gap-2">
                                <div className="flex items-center justify-between">
                                    <WalletOptionIcon wallet={wallet} />
                                    {(() => {
                                        const badge = getTopLevelBadge(wallet);
                                        if (!badge) return null;
                                        return (
                                            <Pill
                                                title={badge.label}
                                                info={badge.tooltip}
                                                className={
                                                    badge.isOffline
                                                        ? "bg-general-warning-background-faded text-general-warning-foreground"
                                                        : "bg-general-success-background-faded text-general-success-foreground"
                                                }
                                            />
                                        );
                                    })()}
                                </div>
                                <div className="text-lg font-semibold">
                                    {wallet.label}
                                </div>
                            </div>
                        </Button>
                    ))}
                </div>
                <Dialog
                    open={walletPickerOpen !== null}
                    onOpenChange={(open) => {
                        if (!open) {
                            setWalletPickerOpen(null);
                            return;
                        }
                        setUnsupportedWallet(null);
                        setIsGuideOpen(false);
                    }}
                >
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>
                                {walletPickerOpen === "near"
                                    ? t("walletSelector.chooseNearWallet")
                                    : t("walletSelector.chooseNearWallet")}
                            </DialogTitle>
                        </DialogHeader>
                        <SlotWarning slot="login" className="mb-2" />
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {walletPickerChoices.map((wallet) => (
                                <div key={wallet.id}>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        className="h-26 w-full items-start justify-start rounded-xl border border-border p-4 text-left hover:bg-muted"
                                        onClick={() =>
                                            handleWalletChoice(wallet)
                                        }
                                        disabled={
                                            isConnectingWallet ||
                                            isWalletChoiceBlocked(wallet.id)
                                        }
                                    >
                                        <div className="flex w-full flex-col gap-2">
                                            <div className="flex items-center justify-between">
                                                <WalletOptionIcon
                                                    wallet={wallet}
                                                />
                                                {(() => {
                                                    const badge =
                                                        getModalBadge(wallet);
                                                    if (!badge) return null;
                                                    return (
                                                        <Pill
                                                            title={badge.label}
                                                            info={badge.tooltip}
                                                            className={
                                                                badge.isOffline
                                                                    ? "bg-general-warning-background-faded text-general-warning-foreground"
                                                                    : "bg-general-success-background-faded text-general-success-foreground"
                                                            }
                                                        />
                                                    );
                                                })()}
                                            </div>
                                            <div className="text-lg font-semibold">
                                                {wallet.label}
                                            </div>
                                        </div>
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </DialogContent>
                </Dialog>
                <Dialog
                    open={isGuideOpen}
                    onOpenChange={(open) => {
                        if (open) {
                            setUnsupportedWallet(null);
                            setWalletPickerOpen(null);
                        }
                        setIsGuideOpen(open);
                    }}
                >
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>
                                {t("walletSelector.guide.title")}
                            </DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                            <div className="rounded-xl border border-general-border p-4">
                                <div className="space-y-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background">
                                        <Wallet className="size-4" />
                                    </div>
                                    <div className="flex flex-col">
                                        <div className="text-lg font-semibold">
                                            {t(
                                                "walletSelector.guide.connectWalletTitle",
                                            )}
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            {t(
                                                "walletSelector.guide.connectWalletDescription",
                                            )}
                                        </p>
                                    </div>
                                    <div className="h-px bg-general-border my-3" />
                                    <div className="space-y-2">
                                        <p className="font-medium mb-1 text-sm">
                                            {t(
                                                "walletSelector.guide.pickThisIfYou",
                                            )}
                                        </p>
                                        <ul className="text-sm text-muted-foreground">
                                            <li>
                                                -{" "}
                                                {t(
                                                    "walletSelector.guide.connectWalletBullet1",
                                                )}
                                            </li>
                                            <li>
                                                -{" "}
                                                {t(
                                                    "walletSelector.guide.connectWalletBullet2",
                                                )}
                                            </li>
                                            <li>
                                                -{" "}
                                                {t(
                                                    "walletSelector.guide.connectWalletBullet3",
                                                )}
                                            </li>
                                        </ul>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-xl border border-general-border p-4">
                                <div className="space-y-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <WalletOptionIcon
                                            wallet={{
                                                id: WALLET_IDS.PASSKEY,
                                                label: "Passkey",
                                                supported: false,
                                            }}
                                        />
                                        <Pill
                                            title={t(
                                                "walletSelector.guide.comingSoon",
                                            )}
                                            variant="info"
                                        />
                                    </div>
                                    <div className="flex flex-col">
                                        <div className="text-lg font-semibold">
                                            {t(
                                                "walletSelector.guide.passkeyTitle",
                                            )}
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            {t(
                                                "walletSelector.guide.passkeyDescription",
                                            )}
                                        </p>
                                    </div>
                                    <div className="h-px bg-general-border my-3" />
                                    <div className="space-y-2">
                                        <p className="font-medium mb-1 text-sm">
                                            {t(
                                                "walletSelector.guide.pickThisIfYou",
                                            )}
                                        </p>
                                        <ul className="text-sm text-muted-foreground">
                                            <li>
                                                -{" "}
                                                {t(
                                                    "walletSelector.guide.passkeyBullet1",
                                                )}
                                            </li>
                                            <li>
                                                -{" "}
                                                {t(
                                                    "walletSelector.guide.passkeyBullet2",
                                                )}
                                            </li>
                                            <li>
                                                -{" "}
                                                {t(
                                                    "walletSelector.guide.passkeyBullet3",
                                                )}
                                            </li>
                                        </ul>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-lg bg-general-tertiary px-4 py-3 text-sm text-muted-foreground">
                                <span className="font-medium text-foreground">
                                    {t("walletSelector.guide.recoveryLabel")}
                                </span>{" "}
                                {t("walletSelector.guide.recoveryText")}
                            </div>

                            {/* <div className="text-center">
                            <a
                                href="#"
                                className="inline-flex items-center gap-2 text-sm font-medium underline-offset-2"
                            >
                                Read the full guide <span aria-hidden>↗</span>
                            </a>
                        </div> */}
                        </div>
                    </DialogContent>
                </Dialog>
                <Dialog
                    open={Boolean(unsupportedWallet)}
                    onOpenChange={(open) => {
                        if (!open && unsupportedWallet)
                            closeUnsupportedWalletModal();
                    }}
                >
                    <DialogContent className="max-w-2xl">
                        <DialogHeader className="border-b-0 pb-0">
                            <DialogTitle className="sr-only">
                                {t("walletNotSupportedTitle", {
                                    wallet: unsupportedWallet?.label ?? "",
                                })}
                            </DialogTitle>
                        </DialogHeader>
                        <div className="space-y-5 text-center">
                            <div className="mx-auto flex items-center justify-center">
                                {unsupportedWallet ? (
                                    <WalletOptionIcon
                                        wallet={unsupportedWallet}
                                        size="xl"
                                    />
                                ) : (
                                    <Wallet className="size-7" />
                                )}
                            </div>
                            <div className="space-y-1">
                                <h3 className="text-xl font-semibold">
                                    {t("walletNotSupportedTitle", {
                                        wallet: unsupportedWallet?.label ?? "",
                                    })}
                                </h3>
                                <p className="text-muted-foreground text-sm">
                                    {t("walletNotSupportedDescription", {
                                        wallet: unsupportedWallet?.label ?? "",
                                    })}
                                </p>
                            </div>
                            <div className="space-y-3">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="w-full"
                                    onClick={() =>
                                        handleWalletChoice({
                                            id: WALLET_IDS.NEAR,
                                            label: "NEAR Wallets",
                                            imgSrc: "/near.com.svg",
                                            supported: true,
                                        })
                                    }
                                >
                                    {t("walletSelector.signInWithNear")}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="w-full"
                                    onClick={() =>
                                        handleWalletChoice({
                                            id: WALLET_IDS.LEDGER,
                                            label: "Ledger",
                                            imgSrc: "/wallets/ledger.svg",
                                            supported: true,
                                        })
                                    }
                                >
                                    {t("walletSelector.signInWithLedger")}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="w-full"
                                    onClick={() =>
                                        handleWalletChoice({
                                            id: WALLET_IDS.EVM,
                                            label: "EVM Wallets",
                                            imgSrc: "/icons/metamask.svg",
                                            supported: true,
                                        })
                                    }
                                >
                                    {t(
                                        "walletSelector.signInWithWalletConnect",
                                    )}
                                </Button>
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            </PageCard>
            {showCreateTreasuryCta && (
                <p className="mt-3 text-center text-sm">
                    {t("dontHaveTreasuryLabel")}{" "}
                    <Button
                        type="button"
                        variant="unstyled"
                        className="h-auto p-0 underline"
                        onClick={() => {
                            if (onCreateTreasuryClick) {
                                onCreateTreasuryClick();
                                return;
                            }
                            router.push("/create");
                        }}
                    >
                        {t("createOneLabel")}
                    </Button>
                </p>
            )}
        </>
    );
}

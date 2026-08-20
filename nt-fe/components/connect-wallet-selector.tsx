"use client";
import { Icon } from "@/components/icon";
import {
    ArrowLeft01Icon,
    Tick01Icon,
    Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SlotWarning } from "@/components/warning-message";
import { Button } from "@/components/button";
import { FingerAccessIcon } from "@/components/icons/finger-access";
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
import { stripMessageForTooltip } from "@/lib/warnings";
import { useNear } from "@/stores/near-store";
import NearBusinessLogo from "./icons/near-business-logo";

type WalletPickerType = "near";

function WalletOptionIcon({
    wallet,
    size = "lg",
}: {
    wallet: WalletOption;
    size?: "lg" | "xl";
}) {
    const sizeClass = size === "xl" ? "size-14" : "size-10";
    if (wallet.id === WALLET_IDS.PASSKEY) {
        return (
            <div className="flex items-center">
                <div
                    className={cn(
                        `${sizeClass} rounded-full bg-foreground text-green-500 flex items-center justify-center`,
                        wallet.imageClassName,
                    )}
                >
                    <FingerAccessIcon
                        className={size === "xl" ? "size-6" : "size-4.5"}
                    />
                </div>
            </div>
        );
    }

    // Primary logo leads the stack and sits on top; the rest fan out to the
    // right underneath it.
    const stackedSources = [
        wallet.imgSrc,
        wallet.secondaryIconSrc,
        wallet.tertiaryIconSrc,
    ].filter(Boolean) as string[];

    return (
        <div className="flex items-center">
            {stackedSources.map((src, index) => (
                <img
                    key={`${wallet.id}-${src}-${index}`}
                    src={src}
                    alt={index === 0 ? wallet.label : ""}
                    className={cn(
                        `${sizeClass} rounded-full bg-black object-cover`,
                        stackedSources.length > 1 && "border-2 border-card",
                        index > 0 && (size === "xl" ? "-ml-5" : "-ml-4"),
                        index === 0
                            ? "relative z-30"
                            : index === 1
                              ? "relative z-20"
                              : "relative z-10",
                        wallet.imageClassName,
                    )}
                />
            ))}
        </div>
    );
}

/**
 * The tile used for every sign-in option: a bordered card with the wallet logo
 * on top, an optional badge in the opposite corner, and the label underneath.
 */
function WalletCard({
    icon,
    badge,
    title,
    description,
    disabled,
    dimmed,
    onClick,
    className,
}: {
    icon: ReactNode;
    badge?: ReactNode;
    title: string;
    description?: string;
    disabled?: boolean;
    dimmed?: boolean;
    onClick: () => void;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-disabled={disabled || dimmed}
            className={cn(
                "flex flex-col items-start gap-5 rounded-2xl border border-general-border bg-card p-[19px] text-left dark:border-general-unofficial-border-2 dark:bg-general-unofficial-accent-0",
                "transition-colors hover:border-general-unofficial-border-4",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:pointer-events-none",
                dimmed
                    ? "cursor-not-allowed opacity-50 hover:border-general-border"
                    : "cursor-pointer",
                className,
            )}
        >
            <div className="flex w-full items-start justify-between gap-2">
                {icon}
                {badge}
            </div>
            <div className="flex w-full flex-col gap-[3px]">
                <span className="text-base font-semibold leading-[1.2]">
                    {title}
                </span>
                {description && (
                    <span className="text-sm font-medium leading-5 text-muted-foreground whitespace-normal">
                        {description}
                    </span>
                )}
            </div>
        </button>
    );
}

interface ConnectWalletSelectorProps {
    source: string;
    connectFlow: "onboarding" | "within_treasury";
    isConnectingWallet?: boolean;
    onBack?: () => void;
    showBackButton?: boolean;
    showOnboardingHints?: boolean;
    onConnectSupported: (walletId?: string) => Promise<void> | void;
    /** Optional context shown above the standard sign-in header. */
    introTitle?: string;
    introDescription?: ReactNode;
}

export function ConnectWalletSelector({
    source,
    connectFlow,
    isConnectingWallet = false,
    onBack,
    showBackButton = false,
    showOnboardingHints = false,
    onConnectSupported,
    introTitle,
    introDescription,
}: ConnectWalletSelectorProps) {
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
                        stripMessageForTooltip(
                            resolveWarningMessage(walletWarning, slot),
                        ) || undefined,
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
                        stripMessageForTooltip(
                            resolveWarningMessage(walletWarning, slot),
                        ) || undefined,
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

    // Passkey is the recommended entry: rendered as a full-width hero card at
    // the top, the rest fill the two-column grid below it.
    const passkeyOption = WALLET_OPTIONS.find(
        (wallet) => wallet.id === WALLET_IDS.PASSKEY,
    );
    const otherOptions = WALLET_OPTIONS.filter(
        (wallet) => wallet.id !== WALLET_IDS.PASSKEY,
    );

    const renderBadge = (badge: BadgeInfo | null) => {
        if (!badge) return null;
        return (
            <Pill
                title={badge.label}
                info={badge.tooltip}
                className={cn(
                    "min-h-6 shrink-0 justify-center rounded-[8px] px-2 py-[3px] text-xs font-semibold leading-[14px]",
                    badge.isOffline
                        ? "bg-general-warning-background-faded text-general-warning-foreground"
                        : "border border-[#D5FFF0] bg-[#F0FFF9] text-[#009660] dark:border-[#076042] dark:bg-[#00C076]/15 dark:text-[#00EC97]",
                )}
            />
        );
    };

    return (
        <>
            <div className="flex flex-col gap-6">
                {(introTitle || introDescription) && (
                    <StepperHeader
                        title={introTitle ?? ""}
                        description={introDescription}
                    />
                )}
                {/* The back control sits on its own row so the heading keeps
                    the column's left edge, as in the design. */}
                {showBackButton && onBack && (
                    <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        onClick={onBack}
                        className="-mb-2 -ml-2 w-fit"
                        aria-label={t("walletSelector.back")}
                    >
                        <Icon icon={ArrowLeft01Icon} />
                    </Button>
                )}
                <div className="flex flex-col gap-[42px]">
                    <div className="flex items-center justify-start">
                        <NearBusinessLogo className="h-7" />
                    </div>
                    <div className="flex flex-col gap-[9px]">
                        <h1 className="text-2xl font-bold leading-[1.2] text-general-foreground">
                            {headerTitle}
                        </h1>
                        <div className="flex flex-col gap-0.5 text-sm font-medium leading-normal text-general-muted-foreground">
                            <p>{t("walletSelector.subtitle")}</p>
                            <button
                                type="button"
                                className="w-fit cursor-pointer rounded-sm underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                onClick={() => setIsGuideOpen(true)}
                            >
                                {t("walletSelector.helpCta")}
                            </button>
                        </div>
                    </div>
                </div>
                <SlotWarning slot="login" />
                {showOnboardingHints && (
                    <div className="flex items-start gap-2">
                        <div className="bg-general-success-background-faded rounded-full size-7 sm:size-6 flex items-center justify-center p-1 sm:p-0">
                            <Icon
                                icon={Tick01Icon}
                                className="shrink-0 text-general-success-foreground"
                            />
                        </div>
                        <p className="text-sm mt-px">
                            {t("walletSelector.noFundsNote")}
                        </p>
                    </div>
                )}
                {passkeyOption &&
                    (() => {
                        const wallet = passkeyOption;
                        const isOfflineBlocked = isWalletChoiceBlocked(
                            wallet.id,
                        );
                        // The passkey card carries no "recommended" badge in the
                        // design — only the Offline warning when it's blocked.
                        const topBadge = getTopLevelBadge(wallet);
                        return (
                            <WalletCard
                                icon={<WalletOptionIcon wallet={wallet} />}
                                badge={renderBadge(
                                    topBadge?.isOffline ? topBadge : null,
                                )}
                                title={t("walletSelector.passkeyCardTitle")}
                                description={t(
                                    "walletSelector.passkeyCardSubtitle",
                                )}
                                disabled={isConnectingWallet}
                                dimmed={isOfflineBlocked}
                                onClick={() => handleWalletChoice(wallet)}
                            />
                        );
                    })()}
                {passkeyOption && (
                    <div role="separator" className="flex items-center gap-6">
                        <span className="h-px flex-1 bg-general-border dark:bg-[#262626]" />
                        <span className="text-sm font-medium leading-6 text-muted-foreground">
                            {t("walletSelector.web3WalletsSeparator")}
                        </span>
                        <span className="h-px flex-1 bg-general-border dark:bg-[#262626]" />
                    </div>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {otherOptions.map((wallet) => {
                        // `dimmed` (aria-disabled) rather than `disabled` when
                        // offline, so the Offline badge tooltip still gets hover.
                        const isOfflineBlocked = isWalletChoiceBlocked(
                            wallet.id,
                        );
                        return (
                            <WalletCard
                                key={wallet.id}
                                icon={<WalletOptionIcon wallet={wallet} />}
                                badge={renderBadge(getTopLevelBadge(wallet))}
                                title={wallet.label}
                                disabled={isConnectingWallet}
                                dimmed={isOfflineBlocked}
                                onClick={() => handleWalletChoice(wallet)}
                            />
                        );
                    })}
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
                    <DialogContent className="gap-4 bg-general-tertiary p-5 dark:bg-general-unofficial-accent sm:max-w-md!">
                        <DialogHeader className="mx-0 border-b-0 bg-general-tertiary px-0 pb-0 dark:bg-general-unofficial-accent">
                            <DialogTitle className="text-left text-base font-semibold">
                                {t("walletSelector.chooseNearWallet")}
                            </DialogTitle>
                        </DialogHeader>
                        <SlotWarning slot="login" />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {walletPickerChoices.map((wallet) => {
                                const isOfflineBlocked = isWalletChoiceBlocked(
                                    wallet.id,
                                );
                                return (
                                    <WalletCard
                                        key={wallet.id}
                                        icon={
                                            <WalletOptionIcon wallet={wallet} />
                                        }
                                        badge={renderBadge(
                                            getModalBadge(wallet),
                                        )}
                                        title={wallet.label}
                                        disabled={isConnectingWallet}
                                        dimmed={isOfflineBlocked}
                                        onClick={() =>
                                            handleWalletChoice(wallet)
                                        }
                                    />
                                );
                            })}
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
                                        <Icon icon={Wallet01Icon} />
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
                                                supported: true,
                                            }}
                                        />
                                        <Pill
                                            title={t(
                                                "walletSelector.guide.passkeyNew",
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
                                        <p className="text-xs text-muted-foreground mt-2">
                                            {t(
                                                "walletSelector.guide.passkeyDomainNote",
                                            )}
                                        </p>
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
                    <DialogContent className="gap-4 p-5 sm:max-w-md!">
                        <DialogHeader className="mx-0 border-b-0 px-0 pb-0">
                            <DialogTitle className="sr-only">
                                {t("walletNotSupportedTitle", {
                                    wallet: unsupportedWallet?.label ?? "",
                                })}
                            </DialogTitle>
                        </DialogHeader>
                        <div className="flex flex-col items-center gap-4 text-center">
                            <div className="flex items-center justify-center">
                                {unsupportedWallet ? (
                                    <WalletOptionIcon
                                        wallet={unsupportedWallet}
                                        size="xl"
                                    />
                                ) : (
                                    <Icon
                                        icon={Wallet01Icon}
                                        className="size-7"
                                    />
                                )}
                            </div>
                            <div className="flex flex-col gap-1">
                                <h3 className="text-xl font-bold leading-tight tracking-[-0.4px]">
                                    {t("walletNotSupportedTitle", {
                                        wallet: unsupportedWallet?.label ?? "",
                                    })}
                                </h3>
                                <p className="text-sm font-medium leading-normal text-muted-foreground">
                                    {t("walletNotSupportedDescription", {
                                        wallet: unsupportedWallet?.label ?? "",
                                    })}
                                </p>
                            </div>
                            <Button
                                type="button"
                                className="h-13 w-full rounded-2xl text-base font-bold"
                                onClick={closeUnsupportedWalletModal}
                            >
                                {t("walletSelector.selectOtherWallet")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>
        </>
    );
}

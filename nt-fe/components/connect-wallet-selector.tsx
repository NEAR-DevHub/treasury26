"use client";

import { Check, Fingerprint, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
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
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

const WALLET_IDS = {
    NEAR: "near",
    LEDGER: "ledger",
    EVM: "walletcontract-eip712",
    PASSKEY: "passkey",
    METEOR: "meteor-wallet",
    INTEAR: "intear-wallet",
    NEAR_MOBILE: "near-mobile",
    NEAR_CLI: "near-cli",
    PHANTOM: "phantom",
} as const;

type WalletId = (typeof WALLET_IDS)[keyof typeof WALLET_IDS];

const MANIFEST_WALLET_IDS = {
    LEDGER: WALLET_IDS.LEDGER,
    METEOR: WALLET_IDS.METEOR,
    INTEAR: WALLET_IDS.INTEAR,
    NEAR_MOBILE: WALLET_IDS.NEAR_MOBILE,
    NEAR_CLI: WALLET_IDS.NEAR_CLI,
    EVM: WALLET_IDS.EVM,
} as const;

export type WalletOption = {
    id: WalletId;
    label: string;
    imgSrc?: string;
    imageClassName?: string;
    secondaryIconSrc?: string;
    tertiaryIconSrc?: string;
    isPopular?: boolean;
    recentGroupAlias?: WalletId;
    supported: boolean;
};

type WalletPickerType = "near";
const LAST_USED_WALLET_STORAGE_KEY = "trezu:last-used-wallet";
const SELECTED_WALLET_STORAGE_KEY = "selected-wallet";

const WALLET_OPTIONS: WalletOption[] = [
    {
        id: WALLET_IDS.NEAR,
        label: "NEAR Wallets",
        imgSrc: "/near.com.svg",
        isPopular: true,
        supported: true,
    },
    {
        id: WALLET_IDS.LEDGER,
        label: "Ledger",
        imgSrc: "/wallets/ledger.svg",
        supported: true,
    },
    {
        id: WALLET_IDS.PASSKEY,
        label: "Passkey",
        supported: false,
    },
    {
        id: WALLET_IDS.PHANTOM,
        label: "Phantom Wallet",
        imgSrc: "/icons/phantom.svg",
        supported: false,
    },
    {
        id: WALLET_IDS.EVM,
        label: "EVM Wallets",
        imgSrc: "/icons/metamask.svg",
        secondaryIconSrc: "/icons/fireblocks.svg",
        tertiaryIconSrc: "/icons/binance-web3.svg",
        supported: true,
    },
];

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
    onConnectSupported: (walletId?: string) => Promise<void> | void;
}

type HotLabsManifestWalletId =
    (typeof MANIFEST_WALLET_IDS)[keyof typeof MANIFEST_WALLET_IDS];

const MANIFEST_WALLET_ID_BY_OPTION: Partial<
    Record<WalletId, HotLabsManifestWalletId>
> = {
    [WALLET_IDS.LEDGER]: MANIFEST_WALLET_IDS.LEDGER,
    [WALLET_IDS.METEOR]: MANIFEST_WALLET_IDS.METEOR,
    [WALLET_IDS.INTEAR]: MANIFEST_WALLET_IDS.INTEAR,
    [WALLET_IDS.NEAR_MOBILE]: MANIFEST_WALLET_IDS.NEAR_MOBILE,
    [WALLET_IDS.NEAR_CLI]: MANIFEST_WALLET_IDS.NEAR_CLI,
    [WALLET_IDS.EVM]: MANIFEST_WALLET_IDS.EVM,
};

const WALLET_GROUP_BY_ID: Partial<Record<WalletId, WalletId>> = {
    [WALLET_IDS.NEAR]: WALLET_IDS.NEAR,
    [WALLET_IDS.EVM]: WALLET_IDS.EVM,
    [WALLET_IDS.LEDGER]: WALLET_IDS.LEDGER,
    [WALLET_IDS.PASSKEY]: WALLET_IDS.PASSKEY,
    [WALLET_IDS.PHANTOM]: WALLET_IDS.PHANTOM,
};

export function ConnectWalletSelector({
    source,
    connectFlow,
    isConnectingWallet = false,
    onBack,
    onConnectSupported,
}: ConnectWalletSelectorProps) {
    const t = useTranslations("createTreasury");
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

    const nearWalletChoices: WalletOption[] = [
        {
            id: WALLET_IDS.METEOR,
            label: "Meteor Wallet",
            imgSrc: "/icons/meteor.svg",
            supported: true,
            isPopular: true,
            recentGroupAlias: WALLET_IDS.NEAR,
        },
        {
            id: WALLET_IDS.INTEAR,
            label: "Intear Wallet",
            imgSrc: "/icons/intear.svg",
            supported: true,
        },
        {
            id: WALLET_IDS.NEAR_MOBILE,
            label: "NEAR Mobile",
            imgSrc: "/icons/near-mobile.svg",
            supported: true,
        },
        {
            id: WALLET_IDS.NEAR_CLI,
            label: "NEAR CLI",
            imgSrc: "/icons/near-cli.svg",
            supported: true,
        },
    ];

    const closeUnsupportedWalletModal = () => {
        setUnsupportedWallet(null);
    };

    const isOnboardingLogin = connectFlow === "onboarding";
    const headerTitle = t("walletSelector.title");
    const headerDescription = isOnboardingLogin ? (
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

    const getWalletGroup = (walletId: string | null): WalletId | null => {
        if (!walletId) return null;

        if (walletId.includes("phantom")) return WALLET_IDS.PHANTOM;
        if (walletId.includes("walletcontract-eip712")) return WALLET_IDS.EVM;
        const knownGroup = WALLET_GROUP_BY_ID[walletId as WalletId];
        if (knownGroup) return knownGroup;
        return WALLET_IDS.NEAR;
    };

    const resolveConnectWalletId = (
        walletId: WalletOption["id"],
    ): WalletOption["id"] | undefined => MANIFEST_WALLET_ID_BY_OPTION[walletId];

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

    const getTopLevelBadgeLabel = (wallet: WalletOption) => {
        const hasRecent = !!lastUsedWalletId || !!recentWalletGroup;
        if (wallet.id === lastUsedWalletId || wallet.id === recentWalletGroup) {
            return t("walletSelector.recentBadge");
        }
        if (hasRecent) {
            return undefined;
        }
        return wallet.isPopular ? t("walletSelector.popularBadge") : undefined;
    };

    const getModalBadgeLabel = (wallet: WalletOption) => {
        if (wallet.id === lastUsedWalletId) {
            return t("walletSelector.recentBadge");
        }

        if (
            wallet.recentGroupAlias &&
            wallet.recentGroupAlias === recentWalletGroup
        ) {
            return t("walletSelector.recentBadge");
        }

        if (wallet.id === recentWalletGroup) {
            return t("walletSelector.recentBadge");
        }

        return wallet.isPopular ? t("walletSelector.popularBadge") : undefined;
    };

    const handleWalletChoice = (wallet: WalletOption) => {
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
            setPendingRecentWalletId(wallet.id);
            const connectWalletId = resolveConnectWalletId(wallet.id);
            const maybeConnect = onConnectSupported(connectWalletId);
            Promise.resolve(maybeConnect).catch(() => {
                setPendingRecentWalletId(null);
            });
            return;
        }

        setUnsupportedWallet(wallet);
    };

    const walletPickerChoices = nearWalletChoices;

    return (
        <PageCard>
            <StepperHeader
                title={headerTitle}
                description={headerDescription}
                handleBack={onBack}
            />
            {isOnboardingLogin && (
                <div className="space-y-3 mb-4">
                    <div className="flex items-start gap-2">
                        <div className="bg-general-success-background-faded rounded-full size-6 flex items-center justify-center">
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
                        disabled={isConnectingWallet}
                    >
                        <div className="flex w-full flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <WalletOptionIcon wallet={wallet} />
                                {getTopLevelBadgeLabel(wallet) && (
                                    <Pill
                                        title={getTopLevelBadgeLabel(wallet)!}
                                        className="bg-general-success-background-faded text-general-success-foreground"
                                    />
                                )}
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {walletPickerChoices.map((wallet) => (
                            <Button
                                key={wallet.id}
                                type="button"
                                variant="secondary"
                                className="h-26 items-start justify-start rounded-xl border border-border p-4 text-left hover:bg-muted"
                                onClick={() => handleWalletChoice(wallet)}
                                disabled={isConnectingWallet}
                            >
                                <div className="flex w-full flex-col gap-2">
                                    <div className="flex items-center justify-between">
                                        <WalletOptionIcon wallet={wallet} />
                                        {getModalBadgeLabel(wallet) && (
                                            <Pill
                                                title={
                                                    getModalBadgeLabel(wallet)!
                                                }
                                                className="bg-general-success-background-faded text-general-success-foreground"
                                            />
                                        )}
                                    </div>
                                    <div className="text-lg font-semibold">
                                        {wallet.label}
                                    </div>
                                </div>
                            </Button>
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
                                        {t("walletSelector.guide.passkeyTitle")}
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
                            {t("walletNotSupportedTitle")}
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
                                {t("walletNotSupportedTitle")}
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
                                {t("walletSelector.signInWithWalletConnect")}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </PageCard>
    );
}

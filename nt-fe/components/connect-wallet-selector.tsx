"use client";

import { Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { StepperHeader } from "@/components/step-wizard";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";

export type WalletOption = {
    id:
        | "near"
        | "ledger"
        | "passkey"
        | "solana"
        | "binance-web3"
        | "phantom"
        | "walletconnect"
        | "stellar";
    label: string;
    imgSrc: string;
    imageClassName?: string;
    supported: boolean;
};

const WALLET_OPTIONS: WalletOption[] = [
    { id: "near", label: "NEAR", imgSrc: "/near.com.svg", supported: true },
    {
        id: "ledger",
        label: "Ledger",
        imgSrc: "/wallets/ledger.svg",
        supported: true,
    },
    {
        id: "passkey",
        label: "Passkey",
        imgSrc: "/icons/passkey.svg",
        supported: false,
    },
    {
        id: "solana",
        label: "Solana",
        imgSrc: "https://near.com/static/icons/network/solana.svg",
        supported: false,
        imageClassName: "p-1.5",
    },
    {
        id: "binance-web3",
        label: "Binance Web3",
        imgSrc: "/icons/binance-web3.svg",
        supported: false,
    },
    {
        id: "phantom",
        label: "Phantom",
        imgSrc: "/icons/phantom.svg",
        supported: false,
    },
    {
        id: "walletconnect",
        label: "WalletConnect",
        imgSrc: "/icons/walletconnect.svg",
        supported: false,
    },
    {
        id: "stellar",
        label: "Stellar",
        imgSrc: "https://near.com/static/icons/network/stellar.svg",
        supported: false,
        imageClassName: "p-1.5",
    },
];

function WalletOptionIcon({
    wallet,
    size = "9",
}: {
    wallet: WalletOption;
    size?: string;
}) {
    return (
        <img
            src={wallet.imgSrc}
            alt={wallet.label}
            className={cn(
                `size-${size} rounded-full bg-black object-cover`,
                wallet.imageClassName,
            )}
        />
    );
}

interface ConnectWalletSelectorProps {
    title: string;
    source: string;
    connectFlow: "new_user" | "existing_user" | "within_treasury";
    isConnectingWallet?: boolean;
    onBack?: () => void;
    onConnectSupported: (walletId?: string) => Promise<void> | void;
}

const LEDGER_WALLET_ID = "ledger";

export function ConnectWalletSelector({
    title,
    source,
    connectFlow,
    isConnectingWallet = false,
    onBack,
    onConnectSupported,
}: ConnectWalletSelectorProps) {
    const tCreate = useTranslations("createTreasury");
    const [unsupportedWallet, setUnsupportedWallet] =
        useState<WalletOption | null>(null);

    const closeUnsupportedWalletModal = () => {
        setUnsupportedWallet(null);
    };

    const handleWalletChoice = (wallet: WalletOption) => {
        trackEvent("onboarding_wallet_option_clicked", {
            wallet_id: wallet.id,
            is_supported: wallet.supported,
            source,
            connect_flow: connectFlow,
        });

        if (wallet.supported) {
            onConnectSupported(
                wallet.id === LEDGER_WALLET_ID ? LEDGER_WALLET_ID : undefined,
            );
            return;
        }

        setUnsupportedWallet(wallet);
    };

    return (
        <PageCard>
            <StepperHeader title={title} handleBack={onBack} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {WALLET_OPTIONS.map((wallet) => (
                    <Button
                        key={wallet.id}
                        type="button"
                        variant="secondary"
                        className="h-15 justify-start gap-3 text-lg"
                        onClick={() => handleWalletChoice(wallet)}
                        disabled={isConnectingWallet}
                    >
                        <WalletOptionIcon wallet={wallet} />
                        <div className="font-semibold">{wallet.label}</div>
                    </Button>
                ))}
            </div>
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
                            {tCreate("walletNotSupportedTitle")}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-5 text-center">
                        <div className="mx-auto flex items-center justify-center">
                            {unsupportedWallet ? (
                                <WalletOptionIcon
                                    wallet={unsupportedWallet}
                                    size="12"
                                />
                            ) : (
                                <Wallet className="size-7" />
                            )}
                        </div>
                        <div className="space-y-1">
                            <h3 className="text-xl font-semibold">
                                {tCreate("walletNotSupportedTitle")}
                            </h3>
                            <p className="text-muted-foreground text-md">
                                {tCreate("walletNotSupportedDescription", {
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
                                        id: "near",
                                        label: "NEAR",
                                        imgSrc: "/near.com.svg",
                                        supported: true,
                                    })
                                }
                            >
                                {tCreate("connectNear")}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                className="w-full"
                                onClick={() =>
                                    handleWalletChoice({
                                        id: "ledger",
                                        label: "Ledger",
                                        imgSrc: "/wallets/ledger.svg",
                                        supported: true,
                                    })
                                }
                            >
                                {tCreate("connectLedger")}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </PageCard>
    );
}

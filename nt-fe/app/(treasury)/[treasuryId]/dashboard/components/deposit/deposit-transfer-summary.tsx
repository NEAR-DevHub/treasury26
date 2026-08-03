"use client";

import { Coins } from "lucide-react";
import { useTranslations } from "next-intl";
import { TokenDisplay } from "@/components/token-display-with-network";
import { TreasuryLogo } from "@/components/treasury-info";
import { NEAR_COM_ICON } from "@/constants/token";
import type { SendTokenMeta } from "./deposit-transfer-resolve";

interface DepositTransferSummaryProps {
    variant: "public" | "confidential";
    sendTokenMeta: SendTokenMeta | null;
    tokenId?: string;
    networkId?: string;
    treasuryDisplayName: string;
    treasuryLogo?: string | null;
    isConfidentialTreasury?: boolean;
}

export function DepositTransferSummary({
    variant,
    sendTokenMeta,
    tokenId = "",
    networkId = "",
    treasuryDisplayName,
    treasuryLogo,
    isConfidentialTreasury = false,
}: DepositTransferSummaryProps) {
    const t = useTranslations("depositModal");

    return (
        <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-general-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                    {variant === "public"
                        ? t("transfer.youSendFromPublic")
                        : t("transfer.youSend")}
                </p>
                <div className="flex items-start gap-2.5">
                    {variant === "public" && sendTokenMeta ? (
                        <TokenDisplay
                            symbol={sendTokenMeta.symbol}
                            icon={sendTokenMeta.icon}
                            chainIcons={sendTokenMeta.chainIcons}
                            iconSize="xl"
                        />
                    ) : (
                        <span className="relative size-9 shrink-0">
                            <span className="absolute inset-0 rounded-full bg-muted border border-border flex items-center justify-center">
                                <Coins className="size-4 text-foreground" />
                            </span>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={NEAR_COM_ICON}
                                alt=""
                                width={20}
                                height={20}
                                className="absolute -bottom-0.5 -right-0.5 size-5 rounded-md border-2 border-card"
                            />
                        </span>
                    )}
                    <div className="min-w-0">
                        {variant === "public" ? (
                            <>
                                <p className="text-sm font-semibold leading-snug">
                                    {sendTokenMeta?.symbol || tokenId}
                                </p>
                                <p className="text-xs text-muted-foreground leading-snug">
                                    {t("transfer.onNetwork", {
                                        network:
                                            sendTokenMeta?.networkName ||
                                            networkId,
                                    })}
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-sm font-semibold leading-snug">
                                    {t("transfer.anyAsset")}
                                </p>
                                <p className="text-xs text-muted-foreground leading-snug">
                                    {t("transfer.onNearcomNetwork")}
                                </p>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="rounded-xl border border-general-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                    {t("transfer.goesTo")}
                </p>
                <div className="flex items-start gap-2.5">
                    <TreasuryLogo
                        logo={treasuryLogo}
                        isConfidential={isConfidentialTreasury}
                        alt={treasuryDisplayName}
                        imageClassName="size-9 rounded-full"
                        fallbackClassName="size-9 rounded-full"
                    />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold leading-snug truncate">
                            {treasuryDisplayName}
                        </p>
                        <p className="text-xs text-muted-foreground leading-snug">
                            {t("transfer.securedOnTrezu")}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

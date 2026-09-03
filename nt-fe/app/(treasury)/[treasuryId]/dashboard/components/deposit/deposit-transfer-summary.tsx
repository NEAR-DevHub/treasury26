"use client";
import { Coins01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { TokenDisplay } from "@/components/token-display-with-network";
import { TokenIconImage } from "@/components/token-icon-image";
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-general-border bg-card p-4 space-y-3">
                <p className="text-sm font-medium leading-normal text-muted-foreground">
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
                                <Icon
                                    icon={Coins01Icon}
                                    className="text-foreground"
                                />
                            </span>
                            <TokenIconImage
                                icon={NEAR_COM_ICON}
                                alt=""
                                className="absolute -bottom-0.5 -right-0.5 size-5"
                            />
                        </span>
                    )}
                    <div className="min-w-0">
                        {variant === "public" ? (
                            <>
                                <p className="text-base font-semibold leading-tight text-foreground">
                                    {sendTokenMeta?.symbol || tokenId}
                                </p>
                                <p className="text-sm font-medium leading-normal text-muted-foreground">
                                    {t("transfer.onNetwork", {
                                        network:
                                            sendTokenMeta?.networkName ||
                                            networkId,
                                    })}
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-base font-semibold leading-tight text-foreground">
                                    {t("transfer.anyAsset")}
                                </p>
                                <p className="text-sm font-medium leading-normal text-muted-foreground">
                                    {t("transfer.onNearcomNetwork")}
                                </p>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="rounded-xl border border-general-border bg-card p-4 space-y-3">
                <p className="text-sm font-medium leading-normal text-muted-foreground">
                    {t("transfer.goesTo")}
                </p>
                <div className="flex items-start gap-2.5">
                    {variant === "confidential" || isConfidentialTreasury ? (
                        <span
                            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-general-bg-primary"
                            aria-hidden
                        >
                            <Icon
                                icon={Shield01Icon}
                                className="size-4 text-green-500"
                            />
                        </span>
                    ) : (
                        <TreasuryLogo
                            logo={treasuryLogo}
                            alt={treasuryDisplayName}
                            imageClassName="size-9 rounded-full"
                            fallbackClassName="size-9 rounded-full"
                        />
                    )}
                    <div className="min-w-0">
                        <p className="truncate text-base font-semibold leading-tight text-foreground">
                            {treasuryDisplayName}
                        </p>
                        <p className="text-sm font-medium leading-normal text-muted-foreground">
                            {isConfidentialTreasury
                                ? t("transfer.securedOnNearcom")
                                : t("transfer.securedOnTrezu")}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

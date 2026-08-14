"use client";

import { ChevronLeft, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormattedAmount } from "@/components/formatted-amount";
import { InfoDisplay, type InfoItem } from "@/components/info-display";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { useStakingValidator } from "@/hooks/use-staking-validator";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import type { TreasuryAsset } from "@/lib/api";
import Big from "@/lib/big";
import { AmountSummary } from "./amount-summary";

interface EarningPoolDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onBack?: () => void;
    asset: TreasuryAsset | null;
    poolId: string | null;
}

export function EarningPoolDetailsModal({
    isOpen,
    onClose,
    onBack,
    asset,
    poolId,
}: EarningPoolDetailsModalProps) {
    const t = useTranslations("earningPoolDetails");
    const tEarning = useTranslations("earningDetails");

    const stakingBalance =
        asset?.balance.type === "Staked" ? asset.balance.staking : null;
    const lockupBalance =
        asset?.balance.type === "Vested" ? asset.balance.lockup : null;
    const isDaoStaking = !!stakingBalance;
    const isLockupStaking = !!lockupBalance && lockupBalance.staked.gt(0);

    const selectedPool = isDaoStaking
        ? stakingBalance?.pools.find((pool) => pool.poolId === poolId)
        : null;

    const lockupPoolId = isLockupStaking
        ? (lockupBalance?.stakingPoolId ?? t("lockupStakingPool"))
        : null;
    const resolvedPoolId = isDaoStaking
        ? (selectedPool?.poolId ?? null)
        : lockupPoolId;
    const validatorPoolId =
        resolvedPoolId && resolvedPoolId.includes(".") ? resolvedPoolId : null;

    const {
        data: validatorDetails,
        isLoading,
        isFetching,
    } = useStakingValidator(isOpen ? validatorPoolId : null);
    const isValidatorMetaLoading =
        !!validatorPoolId && (isLoading || isFetching);

    if (!asset) return null;
    if (!isDaoStaking && !isLockupStaking) return null;
    if (isDaoStaking && !selectedPool) return null;

    const stakedBalance = isDaoStaking
        ? (selectedPool?.stakedBalance ?? Big(0))
        : (lockupBalance?.staked ?? Big(0));
    const unstakedBalance = isDaoStaking
        ? (selectedPool?.unstakedBalance ?? Big(0))
        : (lockupBalance?.unstakedBalance ?? Big(0));
    const canWithdraw = isDaoStaking
        ? (selectedPool?.canWithdraw ?? false)
        : (lockupBalance?.canWithdraw ?? false);

    const poolTotal = stakedBalance.add(unstakedBalance);
    const pendingRelease = canWithdraw ? Big(0) : unstakedBalance;
    const availableForWithdraw = canWithdraw ? unstakedBalance : Big(0);

    const exactTokenBalance = (balance: Big) =>
        decimalFromBaseUnits(balance, asset.decimals).toFixed();
    const formatTokenBalance = (balance: Big) => (
        <FormattedAmount
            kind="raw-token"
            value={balance}
            symbol={asset.symbol}
            tokenDecimals={asset.decimals}
            unitPriceUsd={asset.price}
            profile="standard"
            rounding="down"
        />
    );

    const summaryUsd = poolTotal
        .div(Big(10).pow(asset.decimals))
        .mul(asset.price)
        .toNumber();

    const overviewItems: InfoItem[] = [
        {
            label: tEarning("overview.pendingRelease"),
            value: formatTokenBalance(pendingRelease),
        },
        {
            label: tEarning("overview.availableForWithdraw"),
            value: formatTokenBalance(availableForWithdraw),
        },
    ];

    const poolMetaItems: InfoItem[] = [
        {
            label: t("apy"),
            value: isValidatorMetaLoading ? (
                <Skeleton className="h-4 w-16" />
            ) : validatorDetails?.apy !== undefined ? (
                <span className="text-general-success-foreground">
                    <FormattedAmount
                        kind="percent"
                        value={validatorDetails.apy}
                    />
                </span>
            ) : (
                t("notAvailable")
            ),
        },
        {
            label: t("fee"),
            value: isValidatorMetaLoading ? (
                <Skeleton className="h-4 w-16" />
            ) : validatorDetails?.feePercent !== undefined ? (
                <FormattedAmount
                    kind="percent"
                    value={validatorDetails.feePercent}
                />
            ) : (
                t("notAvailable")
            ),
        },
    ];

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <div className="flex items-center gap-1">
                        {onBack ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-7 -ml-1"
                                onClick={onBack}
                            >
                                <ChevronLeft className="size-4" />
                            </Button>
                        ) : null}
                        <DialogTitle className="text-left">
                            {tEarning("title")}
                        </DialogTitle>
                    </div>
                </DialogHeader>

                <div className="flex flex-col gap-6">
                    <AmountSummary
                        title={t("balance")}
                        total={exactTokenBalance(poolTotal)}
                        totalUSD={summaryUsd}
                        token={{
                            address: asset.contractId || "",
                            symbol: asset.symbol,
                            decimals: asset.decimals,
                            name: asset.name,
                            icon: asset.icon,
                            network: asset.network,
                        }}
                    />

                    {isLockupStaking ? (
                        <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm flex items-start gap-2">
                            <Info className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                            <p className="text-foreground">
                                {t("lockupAssetsNote")}
                            </p>
                        </div>
                    ) : null}

                    <InfoDisplay
                        items={overviewItems}
                        hideSeparator
                        size="sm"
                    />
                    <div className="flex flex-col gap-2">
                        <div className="text-sm font-semibold">
                            {resolvedPoolId}
                        </div>
                        <InfoDisplay
                            items={poolMetaItems}
                            hideSeparator
                            size="sm"
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        className="w-full"
                        disabled
                        tooltipContent={tEarning("comingSoon")}
                    >
                        {tEarning("goToEarn")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

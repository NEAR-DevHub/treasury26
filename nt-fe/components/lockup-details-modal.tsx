"use client";

import { Icon } from "@/components/icon";
import {
    ArrowDown01Icon,
    ArrowLeft01Icon,
    ArrowUp01Icon,
    DollarCircleIcon,
    InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { TreasuryAsset } from "@/lib/api";
import Big from "@/lib/big";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import { formatSmartAmount, formatUserDate } from "@/lib/utils";
import { useTreasuryLockup } from "@/hooks/use-lockup";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AmountSummary } from "./amount-summary";
import { Tooltip } from "./tooltip";

interface LockupDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onBack?: () => void;
    asset: TreasuryAsset | null;
    treasuryId: string | null;
}

interface LockupFormatLabels {
    notAvailable: string;
    everyMonth: string;
    everyQuarter: string;
    everyUnit: (unit: string) => string;
    everyMultiple: (text: string) => string;
    completed: string;
    unit: (key: string, count: number) => string;
}

function formatDateFromSeconds(
    seconds: number | undefined,
    notAvailable: string,
): string {
    if (!seconds || Number.isNaN(seconds) || seconds <= 0) return notAvailable;
    return formatUserDate(seconds * 1000, {
        includeTime: false,
        customFormat: "MMM dd, yyyy",
    });
}

function formatDateFromNanoseconds(
    nanos: number | null | undefined,
    notAvailable: string,
): string {
    if (!nanos || Number.isNaN(nanos) || nanos <= 0) return notAvailable;
    return formatUserDate(nanos / 1_000_000, {
        includeTime: false,
        customFormat: "MMM dd, yyyy",
    });
}

function formatReleaseInterval(
    seconds: number | undefined,
    labels: LockupFormatLabels,
): string {
    if (!seconds || seconds <= 0) return labels.notAvailable;

    if (seconds === 2592000) return labels.everyMonth;
    if (seconds === 7776000) return labels.everyQuarter;

    const units = [
        { seconds: 31536000, key: "year" },
        { seconds: 86400, key: "day" },
        { seconds: 3600, key: "hour" },
        { seconds: 60, key: "minute" },
        { seconds: 1, key: "second" },
    ];

    let remaining = seconds;
    const parts: Array<{ count: number; key: string }> = [];

    for (const unit of units) {
        if (remaining < unit.seconds) continue;
        const count = Math.floor(remaining / unit.seconds);
        if (count <= 0) continue;
        parts.push({ count, key: unit.key });
        remaining %= unit.seconds;
    }

    if (parts.length === 1 && parts[0].count === 1) {
        return labels.everyUnit(labels.unit(parts[0].key, 1));
    }

    const text = parts
        .map((part) => labels.unit(part.key, part.count))
        .join(" ");

    return text ? labels.everyMultiple(text) : labels.notAvailable;
}

function calculateNextFtUnlockDate(
    startTimestamp: number | undefined,
    roundInterval: number | undefined,
    roundsTotal: number | undefined,
    labels: LockupFormatLabels,
): string {
    if (
        !startTimestamp ||
        Number.isNaN(startTimestamp) ||
        !roundInterval ||
        Number.isNaN(roundInterval) ||
        roundInterval <= 0
    ) {
        return labels.notAvailable;
    }

    const totalRounds = roundsTotal ?? 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    let nextUnlock = startTimestamp + roundInterval;
    let releaseIndex = 1;

    while (
        nextUnlock <= nowSeconds &&
        (totalRounds <= 0 || releaseIndex < totalRounds)
    ) {
        nextUnlock += roundInterval;
        releaseIndex += 1;
    }

    if (
        totalRounds > 0 &&
        releaseIndex >= totalRounds &&
        nextUnlock <= nowSeconds
    ) {
        return labels.completed;
    }

    return formatDateFromSeconds(nextUnlock, labels.notAvailable);
}

export function LockupDetailsModal({
    isOpen,
    onClose,
    onBack,
    asset,
    treasuryId,
}: LockupDetailsModalProps) {
    const t = useTranslations("lockupDetails");
    const [guideOpen, setGuideOpen] = useState(false);
    const isNearLockup = asset?.balance.type === "Vested";
    const isFtLockup = !isNearLockup && !!asset?.lockupInstanceId;

    const { data: lockupContract } = useTreasuryLockup(
        isOpen && isNearLockup && treasuryId ? treasuryId : null,
    );

    if (!asset || (!isNearLockup && !isFtLockup)) return null;

    let total = Big(0);
    let locked = Big(0);
    let unlocked = Big(0);
    let progressPct = 0;
    let progressLabel = "0%";
    let reservedStorage = Big(0);
    let lockupStaked = Big(0);
    // Used by progress/locked-unlocked math (falls back to total when missing).
    let allocatedForProgress = Big(0);
    // Raw `totalAllocated` from contract (no fallback), used for earned breakdown.
    let allocatedFromContract = Big(0);
    let summaryTotal = Big(0);

    if (isFtLockup && asset.balance.type === "Standard") {
        const totalRaw =
            asset.ftLockupSchedule?.totalAmount ??
            asset.balance.total.toFixed(0);
        const unlockedRaw = asset.ftLockupSchedule?.unlockedAmount ?? "0";
        const lockedRaw =
            asset.ftLockupSchedule?.lockedAmount ??
            asset.balance.locked.toFixed(0);
        const roundsDone = asset.ftLockupSchedule?.roundsCompleted ?? 0;
        const roundsTotal = asset.ftLockupSchedule?.roundsTotal ?? 0;

        total = decimalFromBaseUnits(totalRaw, asset.decimals);
        unlocked = decimalFromBaseUnits(unlockedRaw, asset.decimals);
        locked = decimalFromBaseUnits(lockedRaw, asset.decimals);
        summaryTotal = total;

        progressPct = total.gt(0) ? unlocked.div(total).mul(100).toNumber() : 0;
        progressLabel =
            roundsTotal > 0
                ? `${roundsDone}/${roundsTotal} Rounds`
                : `${progressPct.toFixed(0)}%`;
    }

    if (isNearLockup && asset.balance.type === "Vested") {
        // NEAR lockup uses vesting-specific fields from lockup balance.
        const allocatedRaw = asset.balance.lockup.totalAllocated.gt(0)
            ? asset.balance.lockup.totalAllocated
            : asset.balance.lockup.total;
        const allocatedRawForBreakdown = asset.balance.lockup.totalAllocated;
        const lockedRaw = asset.balance.lockup.unvested;
        const unlockedRaw = allocatedRaw.sub(lockedRaw);
        lockupStaked = asset.balance.lockup.staked;
        allocatedForProgress = allocatedRaw;
        allocatedFromContract = decimalFromBaseUnits(
            allocatedRawForBreakdown,
            asset.decimals,
        );

        total = decimalFromBaseUnits(allocatedRaw, asset.decimals);
        summaryTotal = decimalFromBaseUnits(
            asset.balance.lockup.total,
            asset.decimals,
        );
        locked = decimalFromBaseUnits(lockedRaw, asset.decimals);
        unlocked = decimalFromBaseUnits(unlockedRaw, asset.decimals);
        progressPct = total.gt(0) ? unlocked.div(total).mul(100).toNumber() : 0;
        // Avoid showing 100% while a non-zero locked balance still exists.
        if (locked.gt(0)) {
            progressLabel = `${Math.min(progressPct, 99.9).toFixed(1)}%`;
        } else {
            progressLabel = "100%";
        }
        reservedStorage = decimalFromBaseUnits(
            asset.balance.lockup.storageLocked,
            asset.decimals,
        );
    }

    const totalUsd = summaryTotal.mul(asset.price).toNumber();

    const roundsTotal = asset.ftLockupSchedule?.roundsTotal ?? 0;

    const lockupFormatLabels: LockupFormatLabels = {
        notAvailable: t("notAvailable"),
        everyMonth: t("everyMonth"),
        everyQuarter: t("everyQuarter"),
        everyUnit: (unit: string) => t("everyUnit", { unit }),
        everyMultiple: (text: string) => t("everyMultiple", { text }),
        completed: t("completed"),
        unit: (key: string, count: number) => t(`unit.${key}`, { count }),
    };

    const nextUnlockDate = calculateNextFtUnlockDate(
        asset.ftLockupSchedule?.startTimestamp,
        asset.ftLockupSchedule?.roundInterval,
        asset.ftLockupSchedule?.roundsTotal,
        lockupFormatLabels,
    );

    const nearStartDate = formatDateFromNanoseconds(
        lockupContract?.vestingSchedule?.startTimestamp,
        lockupFormatLabels.notAvailable,
    );
    const nearEndDate = formatDateFromNanoseconds(
        lockupContract?.vestingSchedule?.endTimestamp,
        lockupFormatLabels.notAvailable,
    );
    const amountSummaryToken = {
        address: asset.contractId || "",
        symbol: asset.symbol,
        decimals: asset.decimals,
        name: asset.name,
        icon: asset.icon,
        network: asset.network,
        chainIcons: asset.chainIcons,
    };
    const allocatedAmountSummary = (
        <AmountSummary
            title={isNearLockup ? t("balance") : t("allocatedAmount")}
            total={summaryTotal.toFixed(2)}
            totalUSD={totalUsd}
            token={amountSummaryToken}
        />
    );
    const hasLockupStakingNotice = isNearLockup && lockupStaked.gt(0);
    const lockupStakedDisplay = formatSmartAmount(
        decimalFromBaseUnits(lockupStaked, asset.decimals),
    );
    const isFullLockupStaked =
        allocatedForProgress.gt(0) && lockupStaked.gte(allocatedForProgress);
    const earnedFromStaking =
        allocatedFromContract.gt(0) && summaryTotal.gt(allocatedFromContract)
            ? summaryTotal.sub(allocatedFromContract)
            : Big(0);
    const showTokenBreakdown =
        isNearLockup && allocatedFromContract.gt(0) && earnedFromStaking.gt(0);

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[560px] overflow-hidden">
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
                                <Icon icon={ArrowLeft01Icon} />
                            </Button>
                        ) : null}
                        <DialogTitle className="text-left">
                            {t("title")}
                        </DialogTitle>
                    </div>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    <div className="space-y-6">
                        {isNearLockup ? (
                            <div className="overflow-hidden rounded-xl border border-border/70">
                                <div className="p-[3px]">
                                    {allocatedAmountSummary}
                                </div>

                                {reservedStorage.gt(0) ? (
                                    <div className="flex items-center justify-between px-2 py-2 text-sm">
                                        <div className="flex items-center gap-1.5 text-muted-foreground">
                                            {t("reservedForStorage")}{" "}
                                            <Tooltip
                                                content={t(
                                                    "reservedForStorageInfo",
                                                )}
                                            >
                                                <Icon
                                                    icon={InformationCircleIcon}
                                                />
                                            </Tooltip>
                                        </div>
                                        <span className="text-foreground">
                                            {reservedStorage.toFixed(2)}{" "}
                                            {asset.symbol}
                                        </span>
                                    </div>
                                ) : null}
                            </div>
                        ) : (
                            allocatedAmountSummary
                        )}
                        {hasLockupStakingNotice ? (
                            <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm flex items-start gap-2">
                                <Icon
                                    icon={InformationCircleIcon}
                                    className="mt-0.5 shrink-0"
                                />
                                <p className="text-foreground">
                                    {isFullLockupStaked
                                        ? t("allEarning", {
                                              amount: lockupStakedDisplay,
                                              symbol: asset.symbol,
                                          })
                                        : t("partEarning", {
                                              amount: lockupStakedDisplay,
                                              symbol: asset.symbol,
                                          })}{" "}
                                    {t("stopEarningFirst")}
                                </p>
                            </div>
                        ) : null}
                        {showTokenBreakdown ? (
                            <div className="space-y-2 text-sm">
                                <p className="font-semibold">
                                    {t("tokenBreakdown")}
                                </p>
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <p className="text-muted-foreground">
                                            {t("allocatedAmount")}
                                        </p>
                                        <p className="font-medium">
                                            {allocatedFromContract.toFixed(2)}{" "}
                                            {asset.symbol}
                                        </p>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <p className="text-muted-foreground">
                                            {t("earned")}
                                        </p>
                                        <p className="text-general-success-foreground font-medium">
                                            +{earnedFromStaking.toFixed(2)}{" "}
                                            {asset.symbol}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between ">
                                <p className="font-semibold">{t("progress")}</p>
                                <p>{progressLabel}</p>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-foreground"
                                    style={{
                                        width: `${Math.min(Math.max(progressPct, 0), 100)}%`,
                                    }}
                                />
                            </div>
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-muted-foreground">
                                        {t("unlocked")}
                                    </p>
                                    <p className="text-general-success-foreground font-medium">
                                        {unlocked.toFixed(2)} {asset.symbol}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-muted-foreground">
                                        {t("locked")}
                                    </p>
                                    <p className="font-medium">
                                        {locked.toFixed(2)} {asset.symbol}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-2 text-sm">
                            <p className="font-semibold">{t("schedule")}</p>
                            {isFtLockup ? (
                                <div className="space-y-2">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {t("startDate")}
                                        </span>
                                        <span>
                                            {formatDateFromSeconds(
                                                asset.ftLockupSchedule
                                                    ?.startTimestamp,
                                                lockupFormatLabels.notAvailable,
                                            )}
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {t("rounds")}
                                        </span>
                                        <span>
                                            {roundsTotal ||
                                                lockupFormatLabels.notAvailable}
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {t("releaseInterval")}
                                        </span>
                                        <span>
                                            {formatReleaseInterval(
                                                asset.ftLockupSchedule
                                                    ?.roundInterval,
                                                lockupFormatLabels,
                                            )}
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {t("nextUnlockDate")}
                                        </span>
                                        <span>{nextUnlockDate}</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {t("startDate")}
                                        </span>
                                        <span>{nearStartDate}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {t("endDate")}
                                        </span>
                                        <span>{nearEndDate}</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        <Collapsible
                            open={guideOpen}
                            onOpenChange={setGuideOpen}
                            className="overflow-hidden lockup-grant-box"
                        >
                            <CollapsibleTrigger asChild>
                                <button
                                    type="button"
                                    className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium cursor-pointer"
                                >
                                    <span className="flex items-center gap-2">
                                        <Icon
                                            icon={DollarCircleIcon}
                                            className="text-muted-foreground"
                                        />
                                        {t("howGrantWorks")}
                                    </span>
                                    {guideOpen ? (
                                        <Icon
                                            icon={ArrowUp01Icon}
                                            className="text-muted-foreground"
                                        />
                                    ) : (
                                        <Icon
                                            icon={ArrowDown01Icon}
                                            className="text-muted-foreground"
                                        />
                                    )}
                                </button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="px-3 pb-3 text-xs text-muted-foreground">
                                {isFtLockup ? (
                                    <ol className="list-decimal pl-4 space-y-1">
                                        <li>{t("ftStep1")}</li>
                                        <li>{t("ftStep2")}</li>
                                        <li>{t("ftStep3")}</li>
                                    </ol>
                                ) : (
                                    <ol className="list-decimal pl-4 space-y-1">
                                        <li>{t("nearStep1")}</li>
                                        <li>{t("nearStep2")}</li>
                                        <li>{t("nearStep3")}</li>
                                    </ol>
                                )}
                            </CollapsibleContent>
                        </Collapsible>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

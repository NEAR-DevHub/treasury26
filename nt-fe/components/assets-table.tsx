"use client";

import {
    ArrowLeftRight,
    ArrowUpDown,
    ArrowUpRight,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Info,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    Fragment,
    type ReactNode,
    useCallback,
    useMemo,
    useState,
} from "react";
import { AuthButton } from "@/components/auth-button";
import { Button } from "@/components/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AggregatedAsset } from "@/hooks/use-assets";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import type { TreasuryAsset } from "@/lib/api";
import { availableBalance, lockedBalance } from "@/lib/balance";
import Big from "@/lib/big";
import { getDashboardBucketVisibility } from "@/lib/dashboard-balance-view";
import {
    cn,
    formatBalance,
    formatCurrency,
    formatSmartAmount,
} from "@/lib/utils";
import { buildTokenQueryParam } from "@/lib/token-query-param";
import { EarningPoolDetailsModal } from "./earning-pool-details-modal";
import { LockupDetailsModal } from "./lockup-details-modal";
import { BalanceCell, NetworkDisplay } from "./token-display";

type ViewMode = "available" | "locked" | "earning";
type SortDirection = "asc" | "desc";
type NetworkAsset = AggregatedAsset["networks"][number];
type SortKey =
    | "token"
    | "balance"
    | "price"
    | "weight"
    | "locked"
    | "unlocked"
    | "totalAllocated"
    | "earningTotal"
    | "withdrawable";

interface Props {
    aggregatedTokens: AggregatedAsset[];
}

interface AssetMetrics {
    availableUsd: number;
    lockedUsd: number;
    earningUsd: number;
    hasAvailable: boolean;
    hasLocked: boolean;
    hasEarning: boolean;
}

const SORT_BUTTON_CLASS =
    "inline-flex items-center gap-1 hover:text-foreground hover:bg-transparent px-1! uppercase text-xxs";

function toUsd(rawAmount: Big.Big, decimals: number, price: number): number {
    if (price <= 0) return 0;
    return rawAmount.div(Big(10).pow(decimals)).mul(price).toNumber();
}

function networkAvailableRaw(asset: NetworkAsset): Big.Big {
    if (asset.residency === "Staked") return Big(0);
    if (asset.balance.type === "Vested") {
        const staked = asset.balance.lockup.staked;
        const nonStakedLocked = asset.balance.lockup.unvested.sub(staked);
        const locked = nonStakedLocked.gt(0)
            ? nonStakedLocked.add(asset.balance.lockup.storageLocked)
            : asset.balance.lockup.storageLocked;
        const available = asset.balance.lockup.total.sub(staked).sub(locked);
        return available.gt(0) ? available : Big(0);
    }
    return availableBalance(asset.balance);
}

function networkAvailableRawForAvailableView(asset: NetworkAsset): Big.Big {
    if (asset.residency === "Staked" || asset.residency === "Lockup") {
        return Big(0);
    }
    return availableBalance(asset.balance);
}

function networkLockedRaw(asset: NetworkAsset): Big.Big {
    if (asset.residency === "Staked") return Big(0);
    if (asset.balance.type === "Vested") {
        const nonStakedLocked = asset.balance.lockup.unvested.sub(
            asset.balance.lockup.staked,
        );
        const clampedNonStakedLocked = nonStakedLocked.gt(0)
            ? nonStakedLocked
            : Big(0);
        return clampedNonStakedLocked.add(asset.balance.lockup.storageLocked);
    }
    return lockedBalance(asset.balance);
}

function networkEarningRaw(asset: NetworkAsset): Big.Big {
    if (asset.balance.type === "Staked") {
        return asset.balance.staking.stakedBalance.add(
            asset.balance.staking.unstakedBalance,
        );
    }
    if (asset.balance.type === "Vested") {
        return asset.balance.lockup.staked;
    }
    return Big(0);
}

function getAssetMetrics(asset: AggregatedAsset): AssetMetrics {
    let availableUsd = 0;
    let lockedUsd = 0;
    let earningUsd = 0;
    let hasAvailable = false;
    let hasLocked = false;
    let hasEarning = false;

    for (const network of asset.networks) {
        const lockedRaw = networkLockedRaw(network);
        const earningRaw = networkEarningRaw(network);
        const availableForAvailableViewRaw =
            networkAvailableRawForAvailableView(network);

        availableUsd += toUsd(
            availableForAvailableViewRaw,
            network.decimals,
            network.price,
        );
        lockedUsd += toUsd(lockedRaw, network.decimals, network.price);
        earningUsd += toUsd(earningRaw, network.decimals, network.price);

        hasAvailable = hasAvailable || availableForAvailableViewRaw.gt(0);
        hasLocked = hasLocked || lockedRaw.gt(0);
        hasEarning = hasEarning || earningRaw.gt(0);
    }

    return {
        availableUsd,
        lockedUsd,
        earningUsd,
        hasAvailable,
        hasLocked,
        hasEarning,
    };
}

function displayAmount(rawAmount: Big.Big, decimals: number): Big.Big {
    return Big(formatBalance(rawAmount, decimals, decimals));
}

function sumTokenAmountsByNetwork(
    networks: NetworkAsset[],
    getRawAmount: (network: NetworkAsset) => Big.Big,
): Big.Big {
    return networks.reduce(
        (sum, network) =>
            sum.add(displayAmount(getRawAmount(network), network.decimals)),
        Big(0),
    );
}

function defaultSortForView(view: ViewMode): {
    key: SortKey;
    dir: SortDirection;
} {
    if (view === "available") return { key: "balance", dir: "desc" };
    if (view === "locked") return { key: "locked", dir: "desc" };
    return { key: "earningTotal", dir: "desc" };
}

function isSortKeySupportedForView(key: SortKey, view: ViewMode): boolean {
    if (key === "token" || key === "price") return true;
    if (view === "available") return key === "balance" || key === "weight";
    if (view === "locked") {
        return (
            key === "locked" || key === "unlocked" || key === "totalAllocated"
        );
    }
    return key === "earningTotal" || key === "withdrawable";
}

function networkRowKey(
    assetId: string,
    view: ViewMode,
    network: NetworkAsset,
): string {
    return [
        assetId,
        view,
        network.residency,
        network.lockupInstanceId ?? "no-session",
        network.contractId ?? "no-contract",
        network.network,
        network.id,
    ].join(":");
}

function buildTokenParam(network: NetworkAsset): string {
    return buildTokenQueryParam(network);
}

interface MobileEarningPoolRow {
    key: string;
    label: string;
    network: NetworkAsset;
    poolId: string;
    amountRaw: Big.Big;
    amountUsd: number;
}

interface MobileModalData {
    summaryAmount: Big.Big;
    summaryUsd: number;
    summaryLabel: string;
    listLabel: string;
    listNetworks: NetworkAsset[];
    earningPoolRows: MobileEarningPoolRow[];
    weight: number;
}

interface MobileAssetViewModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedAsset: AggregatedAsset | null;
    mobileModalData: MobileModalData | null;
    view: ViewMode;
    renderRows: () => ReactNode;
}

function MobileAssetViewModal({
    open,
    onOpenChange,
    selectedAsset,
    mobileModalData,
    view,
    renderRows,
}: MobileAssetViewModalProps) {
    const t = useTranslations("assetsTable");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="gap-0">
                <DialogHeader>
                    <DialogTitle>
                        {selectedAsset?.networks[0]?.symbol ??
                            selectedAsset?.name ??
                            t("assetDetails")}
                    </DialogTitle>
                </DialogHeader>
                {open && selectedAsset && mobileModalData && (
                    <div className="flex flex-col">
                        <div className="flex items-center gap-3 py-3 border-b border-border/50">
                            <span className="flex-1 text-sm text-muted-foreground">
                                {mobileModalData.summaryLabel}
                            </span>
                            <BalanceCell
                                balance={mobileModalData.summaryAmount}
                                symbol={selectedAsset.id}
                                balanceUSD={mobileModalData.summaryUsd}
                            />
                        </div>
                        <div className="flex items-center gap-3 py-3 border-b border-border/50">
                            <span className="flex-1 text-sm text-muted-foreground">
                                {t("coinPrice")}
                            </span>
                            <span className="text-sm font-medium">
                                {formatCurrency(selectedAsset.price)}
                            </span>
                        </div>
                        {view === "available" && (
                            <div className="flex items-center gap-3 py-3 border-b border-border/50">
                                <span className="flex-1 text-sm text-muted-foreground">
                                    {t("weight")}
                                </span>
                                <div className="w-24 bg-muted rounded-full h-1.5 overflow-hidden shrink-0">
                                    <div
                                        className="bg-foreground h-full rounded-full transition-all"
                                        style={{
                                            width: `${mobileModalData.weight}%`,
                                        }}
                                    />
                                </div>
                                <span className="text-xs font-medium w-14 text-right shrink-0">
                                    {mobileModalData.weight.toFixed(2)}%
                                </span>
                            </div>
                        )}
                        <div className="pt-3 pb-1.5">
                            <span className="text-xxs font-medium uppercase text-muted-foreground">
                                {mobileModalData.listLabel}
                            </span>
                        </div>
                        {renderRows()}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

interface MobileModalLabels {
    balance: string;
    lockedBalance: string;
    totalBalance: string;
    source: string;
    balanceByInvestors: (count: number) => string;
    poolBreakdown: string;
    lockupStakingPool: string;
}

function buildMobileModalData(
    selectedAsset: AggregatedAsset,
    view: ViewMode,
    labels: MobileModalLabels,
    weight?: number,
): MobileModalData {
    const availableNetworks = selectedAsset.networks.filter(
        (n) =>
            n.residency !== "Staked" &&
            networkAvailableRawForAvailableView(n).gt(0),
    );
    // Locked view still includes lockup rows with currently unlocked amounts
    const lockedNetworks = selectedAsset.networks.filter((n) => {
        if (n.residency === "Staked") return false;
        return (
            networkLockedRaw(n).gt(0) ||
            (n.residency === "Lockup" && networkAvailableRaw(n).gt(0))
        );
    });
    const earningNetworks = selectedAsset.networks.filter(
        (n) =>
            ((n.residency === "Staked" &&
                n.balance.type === "Staked" &&
                n.balance.staking.pools.some((pool) =>
                    pool.stakedBalance.gt(0),
                )) ||
                (n.balance.type === "Vested" &&
                    n.balance.lockup.staked.gt(0))) &&
            networkEarningRaw(n).gt(0),
    );

    const listNetworks =
        view === "available"
            ? availableNetworks
            : view === "locked"
              ? lockedNetworks
              : earningNetworks;

    const earningPoolRows = earningNetworks.flatMap((network, networkIdx) => {
        if (network.balance.type === "Staked") {
            return network.balance.staking.pools
                .filter((pool) => pool.stakedBalance.gt(0))
                .map((pool, poolIdx) => {
                    const poolTotal = pool.stakedBalance.add(
                        pool.unstakedBalance,
                    );
                    return {
                        key: `${selectedAsset.id}-mobile-earning-${networkIdx}-${poolIdx}`,
                        label: pool.poolId,
                        network,
                        poolId: pool.poolId,
                        amountRaw: poolTotal,
                        amountUsd: toUsd(
                            poolTotal,
                            network.decimals,
                            network.price,
                        ),
                    };
                });
        }

        if (
            network.balance.type === "Vested" &&
            network.balance.lockup.staked.gt(0)
        ) {
            const poolId =
                network.balance.lockup.stakingPoolId ??
                labels.lockupStakingPool;
            const poolTotal = network.balance.lockup.staked.add(
                network.balance.lockup.unstakedBalance,
            );
            return [
                {
                    key: `${selectedAsset.id}-mobile-earning-lockup-${networkIdx}`,
                    label: poolId,
                    network,
                    poolId,
                    amountRaw: poolTotal,
                    amountUsd: toUsd(
                        poolTotal,
                        network.decimals,
                        network.price,
                    ),
                },
            ];
        }

        return [];
    });

    const summaryAmount =
        view === "available"
            ? sumTokenAmountsByNetwork(
                  availableNetworks,
                  networkAvailableRawForAvailableView,
              )
            : view === "locked"
              ? sumTokenAmountsByNetwork(lockedNetworks, networkLockedRaw)
              : sumTokenAmountsByNetwork(earningNetworks, networkEarningRaw);
    const summaryUsd =
        view === "available"
            ? availableNetworks.reduce(
                  (sum, n) =>
                      sum +
                      toUsd(
                          networkAvailableRawForAvailableView(n),
                          n.decimals,
                          n.price,
                      ),
                  0,
              )
            : view === "locked"
              ? lockedNetworks.reduce(
                    (sum, n) =>
                        sum + toUsd(networkLockedRaw(n), n.decimals, n.price),
                    0,
                )
              : earningNetworks.reduce(
                    (sum, n) =>
                        sum + toUsd(networkEarningRaw(n), n.decimals, n.price),
                    0,
                );
    const summaryLabel =
        view === "available"
            ? labels.balance
            : view === "locked"
              ? labels.lockedBalance
              : labels.totalBalance;
    const listLabel =
        view === "available"
            ? labels.source
            : view === "locked"
              ? labels.balanceByInvestors(lockedNetworks.length)
              : labels.poolBreakdown;

    return {
        summaryAmount,
        summaryUsd,
        summaryLabel,
        listLabel,
        listNetworks,
        earningPoolRows,
        weight: weight ?? 0,
    };
}

interface MergedAvailableNetwork {
    network: NetworkAsset;
    availableRaw: Big.Big;
    isLockupUnlocked: boolean;
}

interface BaseAssetViewProps {
    asset: AggregatedAsset;
    isMobile: boolean;
    isExpanded: boolean;
}

interface AvailableViewProps extends BaseAssetViewProps {
    availableAmount?: Big.Big;
    availableUsd?: number;
    weight?: number;
    availableNetworks?: NetworkAsset[];
    selectedAssetId?: string;
    treasuryId?: string | null;
    onNavigate?: (href: string) => void;
}

function AvailableView({
    asset,
    isMobile,
    isExpanded,
    availableAmount,
    availableUsd,
    weight,
    availableNetworks,
    selectedAssetId,
    treasuryId,
    onNavigate,
}: AvailableViewProps): ReactNode {
    const t = useTranslations("assetsTable");
    if (!isExpanded) {
        return (
            <>
                <TableCell className="p-4 text-right">
                    <BalanceCell
                        balance={availableAmount ?? Big(0)}
                        symbol={asset.id}
                        balanceUSD={availableUsd ?? 0}
                    />
                </TableCell>
                <TableCell className="p-4 text-right font-medium hidden sm:table-cell">
                    {formatCurrency(asset.price)}
                </TableCell>
                <TableCell className="p-4 text-right hidden sm:table-cell">
                    <div className="flex items-center justify-end gap-3">
                        <span className="font-medium w-14 text-right">
                            {(weight ?? 0).toFixed(2)}%
                        </span>
                        <div className="w-24 bg-muted rounded-full h-2 overflow-hidden">
                            <div
                                className="bg-foreground h-full rounded-full"
                                style={{
                                    width: `${weight ?? 0}%`,
                                }}
                            />
                        </div>
                    </div>
                </TableCell>
            </>
        );
    }

    if (isMobile) {
        return (
            <>
                {(availableNetworks ?? []).map((network) => {
                    const amountRaw =
                        networkAvailableRawForAvailableView(network);
                    const amountUsd = toUsd(
                        amountRaw,
                        network.decimals,
                        network.price,
                    );
                    const isLockupUnlocked = !!network.lockupInstanceId;
                    const tokenParam = buildTokenParam(network);
                    return (
                        <div
                            key={networkRowKey(
                                selectedAssetId ?? asset.id,
                                "available",
                                network,
                            )}
                            className="py-3 border-b border-border/50"
                        >
                            <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                    <NetworkDisplay
                                        asset={network}
                                        subLabel={
                                            isLockupUnlocked
                                                ? t("unlockedToken")
                                                : undefined
                                        }
                                    />
                                </div>
                                <div className="text-right shrink-0">
                                    <BalanceCell
                                        balance={displayAmount(
                                            amountRaw,
                                            network.decimals,
                                        )}
                                        symbol={network.symbol}
                                        balanceUSD={amountUsd}
                                    />
                                </div>
                            </div>
                            {!isLockupUnlocked && (
                                <div className="mt-2 flex justify-end">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="h-auto p-0 text-sm font-medium text-foreground hover:bg-transparent"
                                        onClick={() =>
                                            onNavigate?.(
                                                `/${treasuryId}/payments?token=${tokenParam}`,
                                            )
                                        }
                                    >
                                        <ArrowUpRight className="size-4" />{" "}
                                        {t("send")}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="h-auto p-0 text-sm font-medium text-foreground hover:bg-transparent pr-0!"
                                        onClick={() =>
                                            onNavigate?.(
                                                `/${treasuryId}/exchange?sellToken=${tokenParam}`,
                                            )
                                        }
                                    >
                                        <ArrowLeftRight className="size-4" />{" "}
                                        {t("exchange")}
                                    </Button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </>
        );
    }

    const mergedAvailableNetworks = mergeAvailableNetworks(
        availableNetworks ?? [],
    );
    return (
        <>
            <TableRow className="bg-muted/30 uppercase text-muted-foreground font-medium hover:bg-muted/30">
                <TableCell className="p-2 pl-16 text-xxs">
                    {t("source")}
                </TableCell>
                <TableCell className="p-2 text-xxs text-right">
                    {t("balance")}
                </TableCell>
                <TableCell colSpan={3} />
            </TableRow>
            {mergedAvailableNetworks.map(
                ({
                    network,
                    availableRaw: mergedAvailableRaw,
                    isLockupUnlocked,
                }) => {
                    const tokenParam = buildTokenParam(network);
                    return (
                        <TableRow
                            key={networkRowKey(asset.id, "available", network)}
                            className="bg-muted/30 group"
                        >
                            <TableCell className="p-4 pl-16">
                                <NetworkDisplay
                                    asset={network}
                                    subLabel={
                                        isLockupUnlocked
                                            ? t("unlockedToken")
                                            : undefined
                                    }
                                />
                            </TableCell>
                            <TableCell className="p-4 text-right">
                                <BalanceCell
                                    balance={displayAmount(
                                        mergedAvailableRaw,
                                        network.decimals,
                                    )}
                                    symbol={network.symbol}
                                    balanceUSD={toUsd(
                                        mergedAvailableRaw,
                                        network.decimals,
                                        network.price,
                                    )}
                                />
                            </TableCell>
                            <TableCell />
                            <TableCell className="p-4">
                                {!isLockupUnlocked && (
                                    <div className="flex gap-1 justify-end">
                                        <AuthButton
                                            permissionKind="call"
                                            permissionAction="AddProposal"
                                            variant="ghost"
                                            size="icon"
                                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                            tooltipContent={t("exchange")}
                                            onClick={() =>
                                                onNavigate?.(
                                                    `/${treasuryId}/exchange?sellToken=${tokenParam}`,
                                                )
                                            }
                                        >
                                            <ArrowLeftRight className="size-4 text-primary" />
                                        </AuthButton>
                                        <AuthButton
                                            permissionKind="transfer"
                                            permissionAction="AddProposal"
                                            variant="ghost"
                                            size="icon"
                                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                            tooltipContent={t("send")}
                                            onClick={() =>
                                                onNavigate?.(
                                                    `/${treasuryId}/payments?token=${tokenParam}`,
                                                )
                                            }
                                        >
                                            <ArrowUpRight className="size-4 text-primary" />
                                        </AuthButton>
                                    </div>
                                )}
                            </TableCell>
                            <TableCell />
                        </TableRow>
                    );
                },
            )}
        </>
    );
}

function buildAvailableSourceKey(
    network: NetworkAsset,
    isLockupUnlocked: boolean,
): string {
    return [
        network.network,
        isLockupUnlocked ? "lockup-unlocked" : network.residency,
        network.contractId ?? network.id,
    ].join(":");
}

function mergeAvailableNetworks(
    availableNetworks: NetworkAsset[],
): MergedAvailableNetwork[] {
    const bySource = new Map<string, MergedAvailableNetwork>();

    for (const network of availableNetworks) {
        const isLockupUnlocked = !!network.lockupInstanceId;
        const sourceKey = buildAvailableSourceKey(network, isLockupUnlocked);
        const availableRaw = networkAvailableRawForAvailableView(network);
        const existing = bySource.get(sourceKey);

        if (existing) {
            existing.availableRaw = existing.availableRaw.add(availableRaw);
        } else {
            bySource.set(sourceKey, {
                network,
                availableRaw,
                isLockupUnlocked,
            });
        }
    }

    return Array.from(bySource.values());
}

interface LockedViewProps extends BaseAssetViewProps {
    lockedAmount?: Big.Big;
    lockedUsd?: number;
    unlockedAmount?: Big.Big;
    unlockedUsd?: number;
    totalAllocatedAmount?: Big.Big;
    totalAllocatedUsd?: number;
    lockedNetworks?: NetworkAsset[];
    ftLockupInstanceCount?: number;
    selectedAssetId?: string;
    onSelectLockup?: (network: TreasuryAsset) => void;
}

function LockedView({
    asset,
    isMobile,
    isExpanded,
    lockedAmount,
    lockedUsd,
    unlockedAmount,
    unlockedUsd,
    totalAllocatedAmount,
    totalAllocatedUsd,
    lockedNetworks,
    ftLockupInstanceCount,
    selectedAssetId,
    onSelectLockup,
}: LockedViewProps): ReactNode {
    const t = useTranslations("assetsTable");
    if (!isExpanded) {
        return (
            <>
                <TableCell className="p-4 text-right hidden sm:table-cell">
                    <BalanceCell
                        balance={lockedAmount ?? Big(0)}
                        symbol={asset.id}
                        balanceUSD={lockedUsd ?? 0}
                    />
                </TableCell>
                <TableCell className="p-4 text-right">
                    <BalanceCell
                        balance={unlockedAmount ?? Big(0)}
                        symbol={asset.id}
                        balanceUSD={unlockedUsd ?? 0}
                    />
                </TableCell>
                <TableCell className="p-4 text-right font-medium hidden sm:table-cell">
                    {formatCurrency(asset.price)}
                </TableCell>
                <TableCell className="p-4 text-right hidden sm:table-cell">
                    <BalanceCell
                        balance={totalAllocatedAmount ?? Big(0)}
                        symbol={asset.id}
                        balanceUSD={totalAllocatedUsd ?? 0}
                    />
                </TableCell>
            </>
        );
    }

    if (isMobile) {
        return (
            <>
                {(lockedNetworks ?? []).map((network) => {
                    const amountRaw = networkLockedRaw(network);
                    const amountUsd = toUsd(
                        amountRaw,
                        network.decimals,
                        network.price,
                    );
                    const canOpenDetails =
                        network.residency === "Lockup" ||
                        !!network.lockupInstanceId;
                    return (
                        <div
                            key={networkRowKey(
                                selectedAssetId ?? asset.id,
                                "locked",
                                network,
                            )}
                            className="py-3 border-b border-border/50"
                        >
                            <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                    <NetworkDisplay asset={network} />
                                </div>
                                <div className="text-right shrink-0">
                                    <BalanceCell
                                        balance={displayAmount(
                                            amountRaw,
                                            network.decimals,
                                        )}
                                        symbol={network.symbol}
                                        balanceUSD={amountUsd}
                                    />
                                </div>
                            </div>
                            {canOpenDetails && (
                                <div className="mt-2 flex justify-end">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="h-auto p-0 text-sm font-medium text-foreground hover:bg-transparent"
                                        onClick={() =>
                                            onSelectLockup?.(network)
                                        }
                                    >
                                        {t("details")}{" "}
                                        <ChevronRight className="size-4" />
                                    </Button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </>
        );
    }

    return (
        <>
            <TableRow className="bg-muted/30 uppercase text-muted-foreground font-medium hover:bg-muted/30">
                <TableCell className="p-2 pl-16 text-xxs">
                    {t("investors", {
                        count: (lockedNetworks ?? []).length,
                    })}
                </TableCell>
                <TableCell colSpan={5} />
            </TableRow>
            {(lockedNetworks ?? []).map((network) => {
                const lockedRawNetwork = networkLockedRaw(network);
                const unlockedRawNetwork = networkAvailableRaw(network);
                const totalAllocated = lockedRawNetwork.add(unlockedRawNetwork);
                return (
                    <TableRow
                        key={networkRowKey(asset.id, "locked", network)}
                        className="bg-muted/30 cursor-pointer hover:bg-muted/50 group"
                        onClick={() => onSelectLockup?.(network)}
                    >
                        <TableCell className="p-4 pl-16">
                            <div className="space-y-1">
                                <div className="flex items-center gap-3">
                                    {network.icon ? (
                                        <img
                                            src={network.icon}
                                            alt={network.symbol}
                                            className="size-6 rounded-full"
                                        />
                                    ) : (
                                        <div className="size-6 rounded-full bg-gradient-cyan-blue flex items-center justify-center text-white text-xs font-semibold">
                                            {network.symbol
                                                .charAt(0)
                                                .toUpperCase()}
                                        </div>
                                    )}
                                    <div className="flex flex-col text-left">
                                        <span className="font-semibold">
                                            {network.symbol}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            Locked Token
                                            {(ftLockupInstanceCount ?? 0) > 1 &&
                                                network.lockupInstanceId && (
                                                    <span>
                                                        {" "}
                                                        -{" "}
                                                        {network.lockupInstanceId.replace(
                                                            ".ft-lockup.near",
                                                            "",
                                                        )}
                                                    </span>
                                                )}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </TableCell>
                        <TableCell className="p-4 text-right">
                            <BalanceCell
                                balance={displayAmount(
                                    lockedRawNetwork,
                                    network.decimals,
                                )}
                                symbol={network.symbol}
                                balanceUSD={toUsd(
                                    lockedRawNetwork,
                                    network.decimals,
                                    network.price,
                                )}
                            />
                        </TableCell>
                        <TableCell className="p-4 text-right">
                            <BalanceCell
                                balance={displayAmount(
                                    unlockedRawNetwork,
                                    network.decimals,
                                )}
                                symbol={network.symbol}
                                balanceUSD={toUsd(
                                    unlockedRawNetwork,
                                    network.decimals,
                                    network.price,
                                )}
                            />
                        </TableCell>
                        <TableCell />
                        <TableCell className="p-4 text-right">
                            <BalanceCell
                                balance={displayAmount(
                                    totalAllocated,
                                    network.decimals,
                                )}
                                symbol={network.symbol}
                                balanceUSD={toUsd(
                                    totalAllocated,
                                    network.decimals,
                                    network.price,
                                )}
                            />
                        </TableCell>
                        <TableCell className="p-4 text-right">
                            <ChevronRight className="size-4 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </TableCell>
                    </TableRow>
                );
            })}
        </>
    );
}

interface EarningViewProps extends BaseAssetViewProps {
    earningAmount?: Big.Big;
    earningUsd?: number;
    earningWithdrawAmount?: Big.Big;
    earningWithdrawUsd?: number;
    earningNetworks?: NetworkAsset[];
    earningPoolRows?: MobileEarningPoolRow[];
    onSelectPool?: (network: TreasuryAsset, poolId: string) => void;
}

function EarningView({
    asset,
    isMobile,
    isExpanded,
    earningAmount,
    earningUsd,
    earningWithdrawAmount,
    earningWithdrawUsd,
    earningNetworks,
    earningPoolRows,
    onSelectPool,
}: EarningViewProps): ReactNode {
    const t = useTranslations("assetsTable");
    if (!isExpanded) {
        return (
            <>
                <TableCell className="p-4 text-right">
                    <BalanceCell
                        balance={earningAmount ?? Big(0)}
                        symbol={asset.id}
                        balanceUSD={earningUsd ?? 0}
                    />
                </TableCell>
                <TableCell className="p-4 text-right font-medium hidden sm:table-cell">
                    {formatCurrency(asset.price)}
                </TableCell>
                <TableCell className="p-4 text-right hidden sm:table-cell">
                    <BalanceCell
                        balance={earningWithdrawAmount ?? Big(0)}
                        symbol={asset.id}
                        balanceUSD={earningWithdrawUsd ?? 0}
                    />
                </TableCell>
            </>
        );
    }

    if (isMobile) {
        return (
            <>
                {(earningPoolRows ?? []).map((poolRow) => {
                    const network = poolRow.network;
                    return (
                        <div
                            key={poolRow.key}
                            className="py-3 border-b border-border/50"
                        >
                            <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                    <div className="truncate text-sm font-medium text-foreground">
                                        {poolRow.label}
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    <BalanceCell
                                        balance={displayAmount(
                                            poolRow.amountRaw,
                                            network.decimals,
                                        )}
                                        symbol={network.symbol}
                                        balanceUSD={poolRow.amountUsd}
                                    />
                                </div>
                            </div>
                            <div className="mt-2 flex justify-end">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    className="h-auto p-0 text-sm font-medium text-foreground hover:bg-transparent"
                                    onClick={() =>
                                        onSelectPool?.(network, poolRow.poolId)
                                    }
                                >
                                    {t("details")}{" "}
                                    <ChevronRight className="size-4" />
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </>
        );
    }

    return (
        <>
            <TableRow className="bg-muted/30 uppercase text-muted-foreground font-medium hover:bg-muted/30">
                <TableCell className="p-2 pl-16 text-xxs">
                    {t("poolBreakdown")}
                </TableCell>
                <TableCell colSpan={4} />
            </TableRow>
            {(earningNetworks ?? []).flatMap((network, networkIdx) => {
                if (network.balance.type === "Staked") {
                    return network.balance.staking.pools.map(
                        (pool, poolIdx) => {
                            const poolTotal = pool.stakedBalance.add(
                                pool.unstakedBalance,
                            );
                            const poolWithdraw = pool.canWithdraw
                                ? pool.unstakedBalance
                                : Big(0);
                            return (
                                <TableRow
                                    key={`${asset.id}-earning-${networkIdx}-${poolIdx}`}
                                    className="bg-muted/30 cursor-pointer hover:bg-muted/50 group"
                                    onClick={() =>
                                        onSelectPool?.(network, pool.poolId)
                                    }
                                >
                                    <TableCell className="p-4 pl-16">
                                        <div className="font-medium text-sm">
                                            {pool.poolId}
                                        </div>
                                    </TableCell>
                                    <TableCell className="p-4 text-right">
                                        <BalanceCell
                                            balance={displayAmount(
                                                poolTotal,
                                                network.decimals,
                                            )}
                                            symbol={network.symbol}
                                            balanceUSD={toUsd(
                                                poolTotal,
                                                network.decimals,
                                                network.price,
                                            )}
                                        />
                                    </TableCell>
                                    <TableCell />
                                    <TableCell className="p-4 text-right">
                                        <BalanceCell
                                            balance={displayAmount(
                                                poolWithdraw,
                                                network.decimals,
                                            )}
                                            symbol={network.symbol}
                                            balanceUSD={toUsd(
                                                poolWithdraw,
                                                network.decimals,
                                                network.price,
                                            )}
                                        />
                                    </TableCell>
                                    <TableCell className="p-4 text-right">
                                        <ChevronRight className="size-4 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </TableCell>
                                </TableRow>
                            );
                        },
                    );
                }

                if (
                    network.balance.type === "Vested" &&
                    network.balance.lockup.staked.gt(0)
                ) {
                    // Lockup staking exposes a single logical pool via stakingPoolId.
                    const lockupPoolId =
                        network.balance.lockup.stakingPoolId ??
                        t("lockupStakingPool");
                    const poolTotal = network.balance.lockup.staked.add(
                        network.balance.lockup.unstakedBalance,
                    );
                    const poolWithdraw = network.balance.lockup.canWithdraw
                        ? network.balance.lockup.unstakedBalance
                        : Big(0);
                    return [
                        <TableRow
                            key={`${asset.id}-earning-lockup-${networkIdx}`}
                            className="bg-muted/30 cursor-pointer hover:bg-muted/50 group"
                            onClick={() =>
                                onSelectPool?.(network, lockupPoolId)
                            }
                        >
                            <TableCell className="p-4 pl-16">
                                <div className="font-medium text-sm">
                                    {lockupPoolId}
                                </div>
                            </TableCell>
                            <TableCell className="p-4 text-right">
                                <BalanceCell
                                    balance={displayAmount(
                                        poolTotal,
                                        network.decimals,
                                    )}
                                    symbol={network.symbol}
                                    balanceUSD={toUsd(
                                        poolTotal,
                                        network.decimals,
                                        network.price,
                                    )}
                                />
                            </TableCell>
                            <TableCell />
                            <TableCell className="p-4 text-right">
                                <BalanceCell
                                    balance={displayAmount(
                                        poolWithdraw,
                                        network.decimals,
                                    )}
                                    symbol={network.symbol}
                                    balanceUSD={toUsd(
                                        poolWithdraw,
                                        network.decimals,
                                        network.price,
                                    )}
                                />
                            </TableCell>
                            <TableCell className="p-4 text-right">
                                <ChevronRight className="size-4 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                            </TableCell>
                        </TableRow>,
                    ];
                }

                return [];
            })}
        </>
    );
}

interface ExpandedRowsProps extends BaseAssetViewProps {
    view: ViewMode;
    availableNetworks: NetworkAsset[];
    lockedNetworks: NetworkAsset[];
    earningNetworks: NetworkAsset[];
    ftLockupInstanceCount: number;
    treasuryId: string | null;
    onNavigate: (href: string) => void;
    onSelectLockup: (network: TreasuryAsset) => void;
    onSelectPool: (network: TreasuryAsset, poolId: string) => void;
}

function ExpandedRows({
    view,
    isMobile,
    isExpanded,
    asset,
    availableNetworks,
    lockedNetworks,
    earningNetworks,
    ftLockupInstanceCount,
    treasuryId,
    onNavigate,
    onSelectLockup,
    onSelectPool,
}: ExpandedRowsProps): ReactNode {
    if (isMobile || !isExpanded) return null;

    if (view === "available" && availableNetworks.length > 0) {
        return (
            <AvailableView
                asset={asset}
                isMobile={false}
                isExpanded
                availableNetworks={availableNetworks}
                treasuryId={treasuryId}
                onNavigate={onNavigate}
            />
        );
    }

    if (view === "locked" && lockedNetworks.length > 0) {
        return (
            <LockedView
                asset={asset}
                isMobile={false}
                isExpanded
                lockedNetworks={lockedNetworks}
                ftLockupInstanceCount={ftLockupInstanceCount}
                onSelectLockup={onSelectLockup}
            />
        );
    }

    if (view === "earning" && earningNetworks.length > 0) {
        return (
            <EarningView
                asset={asset}
                isMobile={false}
                isExpanded
                earningNetworks={earningNetworks}
                onSelectPool={onSelectPool}
            />
        );
    }

    return null;
}

export function AssetsTable({ aggregatedTokens }: Props) {
    const t = useTranslations("assetsTable");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const isMobile = useMediaQuery("(max-width: 640px)");
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [selectedMobileAsset, setSelectedMobileAsset] =
        useState<AggregatedAsset | null>(null);
    const [isMobileViewModalOpen, setIsMobileViewModalOpen] = useState(false);
    const [selectedStakingNetwork, setSelectedStakingNetwork] =
        useState<TreasuryAsset | null>(null);
    const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
    const [isStakingModalOpen, setIsStakingModalOpen] = useState(false);
    const [selectedLockupNetwork, setSelectedLockupNetwork] =
        useState<TreasuryAsset | null>(null);
    const [isLockupModalOpen, setIsLockupModalOpen] = useState(false);
    const [sortState, setSortState] = useState<{
        key: SortKey;
        dir: SortDirection;
    }>({ key: "balance", dir: "desc" });
    const openMobileEarningDetails = useCallback(
        (network: TreasuryAsset, poolId: string | null) => {
            setIsMobileViewModalOpen(false);
            setSelectedStakingNetwork(network);
            setSelectedPoolId(poolId);
            setIsStakingModalOpen(true);
        },
        [],
    );
    const openMobileLockupDetails = useCallback((network: TreasuryAsset) => {
        setIsMobileViewModalOpen(false);
        setSelectedLockupNetwork(network);
        setIsLockupModalOpen(true);
    }, []);
    const navigateFromMobile = useCallback(
        (href: string) => {
            setIsMobileViewModalOpen(false);
            setSelectedMobileAsset(null);
            router.push(href);
        },
        [router],
    );
    const metricsById = useMemo(
        () =>
            new Map(
                aggregatedTokens.map((asset) => [
                    asset.id,
                    getAssetMetrics(asset),
                ]),
            ),
        [aggregatedTokens],
    );

    const totals = useMemo(() => {
        let availableUsd = 0;
        let lockedUsd = 0;
        let earningUsd = 0;
        for (const asset of aggregatedTokens) {
            const metrics = metricsById.get(asset.id);
            if (!metrics) continue;
            availableUsd += metrics.availableUsd;
            lockedUsd += metrics.lockedUsd;
            earningUsd += metrics.earningUsd;
        }
        return { availableUsd, lockedUsd, earningUsd };
    }, [aggregatedTokens, metricsById]);

    const bucketVisibility = useMemo(
        () =>
            getDashboardBucketVisibility(
                aggregatedTokens.flatMap(
                    (asset) => asset.networks,
                ) as TreasuryAsset[],
            ),
        [aggregatedTokens],
    );
    const showLocked = bucketVisibility.showLocked;
    const showEarning = bucketVisibility.showEarning;
    const hasLockedOrEarning = showLocked || showEarning;
    const visibleViews: Array<[ViewMode, string, number]> = [
        ["available", t("viewAvailable"), totals.availableUsd],
    ];
    if (showLocked) {
        visibleViews.push(["locked", t("viewLocked"), totals.lockedUsd]);
    }
    if (showEarning) {
        visibleViews.push(["earning", t("viewEarning"), totals.earningUsd]);
    }
    const [activeView, setActiveView] = useState<ViewMode>("available");

    const view: ViewMode =
        hasLockedOrEarning && visibleViews.some(([id]) => id === activeView)
            ? activeView
            : "available";

    const activeSort = useMemo(() => {
        if (isSortKeySupportedForView(sortState.key, view)) return sortState;
        return defaultSortForView(view);
    }, [sortState, view]);

    const viewAssets = useMemo(() => {
        const filtered = aggregatedTokens.filter((asset) => {
            const metrics = metricsById.get(asset.id);
            if (!metrics) return false;
            if (view === "available") return metrics.hasAvailable;
            if (view === "locked") return metrics.hasLocked;
            return metrics.hasEarning;
        });

        const totalForView = filtered.reduce((sum, asset) => {
            const metrics = metricsById.get(asset.id);
            if (!metrics) return sum;
            if (view === "available") return sum + metrics.availableUsd;
            if (view === "locked") return sum + metrics.lockedUsd;
            return sum + metrics.earningUsd;
        }, 0);

        return filtered
            .map((asset) => {
                const metrics = metricsById.get(asset.id);
                if (!metrics) {
                    return {
                        asset,
                        metrics: getAssetMetrics(asset),
                        weight: 0,
                        sortValues: {
                            token: asset.id.toLowerCase(),
                            balance: 0,
                            price: asset.price,
                            weight: 0,
                            locked: 0,
                            unlocked: 0,
                            totalAllocated: 0,
                            earningTotal: 0,
                            withdrawable: 0,
                        },
                    };
                }
                const valueUsd =
                    view === "available"
                        ? metrics.availableUsd
                        : view === "locked"
                          ? metrics.lockedUsd
                          : metrics.earningUsd;

                const lockedNetworks = asset.networks.filter((n) => {
                    if (n.residency === "Staked") return false;
                    return (
                        networkLockedRaw(n).gt(0) ||
                        (n.residency === "Lockup" &&
                            networkAvailableRaw(n).gt(0))
                    );
                });
                const unlockedUsd = lockedNetworks.reduce(
                    (sum, n) =>
                        sum +
                        toUsd(networkAvailableRaw(n), n.decimals, n.price),
                    0,
                );

                const withdrawableUsd = asset.networks
                    .filter((n) => n.residency === "Staked")
                    .reduce(
                        (sum, n) =>
                            sum +
                            toUsd(
                                availableBalance(n.balance),
                                n.decimals,
                                n.price,
                            ),
                        0,
                    );

                return {
                    asset,
                    metrics,
                    weight:
                        totalForView > 0 ? (valueUsd / totalForView) * 100 : 0,
                    sortValues: {
                        token: asset.id.toLowerCase(),
                        balance: metrics.availableUsd,
                        price: asset.price,
                        weight:
                            totalForView > 0
                                ? (valueUsd / totalForView) * 100
                                : 0,
                        locked: metrics.lockedUsd,
                        unlocked: unlockedUsd,
                        totalAllocated: metrics.lockedUsd + unlockedUsd,
                        earningTotal: metrics.earningUsd,
                        withdrawable: withdrawableUsd,
                    },
                };
            })
            .sort((a, b) => {
                const key = activeSort.key;
                const dir = activeSort.dir === "asc" ? 1 : -1;
                if (key === "token") {
                    return (
                        a.sortValues.token.localeCompare(b.sortValues.token) *
                        dir
                    );
                }
                return (a.sortValues[key] - b.sortValues[key]) * dir;
            });
    }, [aggregatedTokens, metricsById, view, activeSort]);

    const mobileModalData = useMemo(() => {
        if (!isMobileViewModalOpen || !selectedMobileAsset) return null;
        const selectedViewAsset = viewAssets.find(
            ({ asset }) => asset.id === selectedMobileAsset.id,
        );
        return buildMobileModalData(
            selectedMobileAsset,
            view,
            {
                balance: t("balance"),
                lockedBalance: t("lockedBalance"),
                totalBalance: t("totalBalance"),
                source: t("source"),
                balanceByInvestors: (count: number) =>
                    t("balanceByInvestors", { count }),
                poolBreakdown: t("poolBreakdown"),
                lockupStakingPool: t("lockupStakingPool"),
            },
            selectedViewAsset?.weight,
        );
    }, [isMobileViewModalOpen, selectedMobileAsset, viewAssets, view, t]);

    const renderMobileRows = () => {
        if (!mobileModalData || !selectedMobileAsset) return null;

        if (view === "earning") {
            return (
                <EarningView
                    asset={selectedMobileAsset}
                    isMobile
                    isExpanded
                    earningPoolRows={mobileModalData.earningPoolRows}
                    onSelectPool={(network, poolId) =>
                        openMobileEarningDetails(network, poolId)
                    }
                />
            );
        }

        if (view === "locked") {
            return (
                <LockedView
                    asset={selectedMobileAsset}
                    isMobile
                    isExpanded
                    lockedNetworks={mobileModalData.listNetworks}
                    selectedAssetId={selectedMobileAsset.id}
                    onSelectLockup={(network) =>
                        openMobileLockupDetails(network)
                    }
                />
            );
        }

        return (
            <AvailableView
                asset={selectedMobileAsset}
                isMobile
                isExpanded
                availableNetworks={mobileModalData.listNetworks}
                selectedAssetId={selectedMobileAsset.id}
                treasuryId={treasuryId ?? null}
                onNavigate={navigateFromMobile}
            />
        );
    };

    const toggleSort = (key: SortKey) => {
        setSortState((prev) => {
            if (prev.key === key) {
                return {
                    key,
                    dir: prev.dir === "desc" ? "asc" : "desc",
                };
            }
            return {
                key,
                dir: key === "token" ? "asc" : "desc",
            };
        });
    };
    const renderSortIcon = (key: SortKey) => {
        if (activeSort.key !== key) return <ArrowUpDown className="size-3" />;
        return activeSort.dir === "desc" ? (
            <ChevronDown className="size-3" />
        ) : (
            <ChevronUp className="size-3" />
        );
    };
    const renderSortableHead = (
        key: SortKey,
        label: string,
        options?: {
            headClassName?: string;
            buttonClassName?: string;
        },
    ) => (
        <TableHead
            className={cn(
                "uppercase text-xxs text-muted-foreground",
                options?.headClassName,
            )}
        >
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => toggleSort(key)}
                className={cn(SORT_BUTTON_CLASS, options?.buttonClassName)}
            >
                {label} {renderSortIcon(key)}
            </Button>
        </TableHead>
    );

    if (aggregatedTokens.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                {t("noAssetsFound")}
            </div>
        );
    }

    return (
        <div className="overflow-hidden">
            {hasLockedOrEarning && (
                <>
                    <div className="px-4 pt-4 sm:hidden">
                        <Select
                            value={view}
                            onValueChange={(next) => {
                                if (
                                    next === "available" ||
                                    next === "locked" ||
                                    next === "earning"
                                ) {
                                    setActiveView(next);
                                }
                            }}
                        >
                            <SelectTrigger className="h-auto w-auto border-0 bg-transparent px-2 py-1 text-sm font-medium text-foreground shadow-none hover:bg-transparent focus-visible:ring-0 [&_svg]:text-foreground! [&_svg]:opacity-100">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent align="start" className="min-w-56">
                                {visibleViews.map(([id, label, value]) => (
                                    <SelectItem key={id} value={id}>
                                        {label} {formatCurrency(value)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div
                        className={cn(
                            "hidden sm:grid pt-4",
                            visibleViews.length === 2
                                ? "grid-cols-2"
                                : "grid-cols-3",
                        )}
                    >
                        {visibleViews.map(([id, label, value]) => (
                            <Button
                                type="button"
                                variant="ghost"
                                key={id}
                                onClick={() => setActiveView(id)}
                                className={cn(
                                    "h-auto rounded-none text-left border-r border-border/70 border-b-2 border-b-transparent justify-start items-start flex-col hover:bg-transparent",
                                    activeView === id && "border-b-foreground",
                                )}
                            >
                                <p
                                    className={cn(
                                        "text-xs",
                                        activeView === id
                                            ? "text-foreground"
                                            : "text-muted-foreground",
                                    )}
                                >
                                    {label}
                                </p>
                                <p
                                    className={cn(
                                        "text-lg leading-[1.1] font-medium",
                                        activeView === id
                                            ? "text-foreground"
                                            : "text-muted-foreground",
                                    )}
                                >
                                    {formatCurrency(value)}
                                </p>
                            </Button>
                        ))}
                    </div>
                </>
            )}

            <div className={cn(hasLockedOrEarning && "p-4 pt-0")}>
                <Table>
                    <TableHeader className="bg-transparent border-t-0">
                        <TableRow className="hover:bg-transparent">
                            {renderSortableHead("token", t("columnToken"), {
                                headClassName: "pl-0 sm:pl-4",
                                buttonClassName: cn("justify-start"),
                            })}
                            {view === "available" && (
                                <>
                                    {renderSortableHead(
                                        "balance",
                                        t("balance"),
                                        {
                                            headClassName: "text-right",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "price",
                                        t("coinPrice"),
                                        {
                                            headClassName:
                                                "text-right hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead("weight", t("weight"), {
                                        headClassName:
                                            "text-right hidden sm:table-cell",
                                        buttonClassName: "ml-auto",
                                    })}
                                </>
                            )}
                            {view === "locked" && (
                                <>
                                    {renderSortableHead(
                                        "locked",
                                        t("columnLocked"),
                                        {
                                            headClassName: "text-right",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "unlocked",
                                        t("columnUnlocked"),
                                        {
                                            headClassName:
                                                "text-right hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "price",
                                        t("coinPrice"),
                                        {
                                            headClassName:
                                                "text-right hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "totalAllocated",
                                        t("columnTotalAllocated"),
                                        {
                                            headClassName:
                                                "text-right hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                </>
                            )}
                            {view === "earning" && (
                                <>
                                    {renderSortableHead(
                                        "earningTotal",
                                        t("totalBalance"),
                                        {
                                            headClassName: "text-right",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "price",
                                        t("coinPrice"),
                                        {
                                            headClassName:
                                                "text-right hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "withdrawable",
                                        t("columnAvailableToWithdraw"),
                                        {
                                            headClassName:
                                                "text-right hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                </>
                            )}
                            <TableHead className="w-10 hidden sm:table-cell" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {viewAssets.map(({ asset, weight }) => {
                            const isExpanded = !!expanded[asset.id];
                            const availableNetworks = asset.networks.filter(
                                (n) =>
                                    n.residency !== "Staked" &&
                                    networkAvailableRawForAvailableView(n).gt(
                                        0,
                                    ),
                            );
                            const lockedNetworks = asset.networks.filter(
                                (n) => {
                                    if (n.residency === "Staked") return false;
                                    return (
                                        networkLockedRaw(n).gt(0) ||
                                        (n.residency === "Lockup" &&
                                            networkAvailableRaw(n).gt(0))
                                    );
                                },
                            );
                            const ftLockupInstanceCount = lockedNetworks.filter(
                                (n) => !!n.lockupInstanceId,
                            ).length;
                            const earningNetworks = asset.networks.filter(
                                (n) =>
                                    ((n.residency === "Staked" &&
                                        n.balance.type === "Staked" &&
                                        n.balance.staking.pools.some((pool) =>
                                            pool.stakedBalance.gt(0),
                                        )) ||
                                        (n.balance.type === "Vested" &&
                                            n.balance.lockup.staked.gt(0))) &&
                                    networkEarningRaw(n).gt(0),
                            );
                            const earningFromLockedAmount =
                                sumTokenAmountsByNetwork(lockedNetworks, (n) =>
                                    n.balance.type === "Vested"
                                        ? n.balance.lockup.staked
                                        : Big(0),
                                );
                            const allocatedLockedAmount =
                                sumTokenAmountsByNetwork(lockedNetworks, (n) =>
                                    networkLockedRaw(n).add(
                                        networkAvailableRaw(n),
                                    ),
                                );
                            const hasLockedEarningNotice =
                                view === "locked" &&
                                earningFromLockedAmount.gt(0);
                            const isFullLockedInEarning =
                                allocatedLockedAmount.gt(0) &&
                                earningFromLockedAmount.gte(
                                    allocatedLockedAmount,
                                );

                            const availableAmount = sumTokenAmountsByNetwork(
                                availableNetworks,
                                networkAvailableRawForAvailableView,
                            );
                            const availableUsd = availableNetworks.reduce(
                                (sum, n) =>
                                    sum +
                                    toUsd(
                                        networkAvailableRawForAvailableView(n),
                                        n.decimals,
                                        n.price,
                                    ),
                                0,
                            );

                            const lockedAmount = sumTokenAmountsByNetwork(
                                lockedNetworks,
                                networkLockedRaw,
                            );
                            const unlockedAmount = sumTokenAmountsByNetwork(
                                lockedNetworks,
                                networkAvailableRaw,
                            );
                            const totalAllocatedAmount =
                                lockedAmount.add(unlockedAmount);
                            const lockedUsd = lockedNetworks.reduce(
                                (sum, n) =>
                                    sum +
                                    toUsd(
                                        networkLockedRaw(n),
                                        n.decimals,
                                        n.price,
                                    ),
                                0,
                            );
                            const unlockedUsd = lockedNetworks.reduce(
                                (sum, n) =>
                                    sum +
                                    toUsd(
                                        networkAvailableRaw(n),
                                        n.decimals,
                                        n.price,
                                    ),
                                0,
                            );
                            const totalAllocatedUsd = lockedUsd + unlockedUsd;

                            const earningAmount = sumTokenAmountsByNetwork(
                                earningNetworks,
                                networkEarningRaw,
                            );
                            const earningUsd = earningNetworks.reduce(
                                (sum, n) =>
                                    sum +
                                    toUsd(
                                        networkEarningRaw(n),
                                        n.decimals,
                                        n.price,
                                    ),
                                0,
                            );
                            const earningWithdrawAmount =
                                sumTokenAmountsByNetwork(
                                    earningNetworks,
                                    (n) =>
                                        n.balance.type === "Vested"
                                            ? n.balance.lockup.canWithdraw
                                                ? n.balance.lockup
                                                      .unstakedBalance
                                                : Big(0)
                                            : availableBalance(n.balance),
                                );
                            const earningWithdrawUsd = earningNetworks.reduce(
                                (sum, n) =>
                                    sum +
                                    toUsd(
                                        n.balance.type === "Vested"
                                            ? n.balance.lockup.canWithdraw
                                                ? n.balance.lockup
                                                      .unstakedBalance
                                                : Big(0)
                                            : availableBalance(n.balance),
                                        n.decimals,
                                        n.price,
                                    ),
                                0,
                            );

                            return (
                                <Fragment key={asset.id}>
                                    <TableRow
                                        className="cursor-pointer"
                                        onClick={() => {
                                            if (isMobile) {
                                                setSelectedMobileAsset(asset);
                                                setIsMobileViewModalOpen(true);
                                                return;
                                            }
                                            setExpanded((prev) => ({
                                                ...prev,
                                                [asset.id]: !prev[asset.id],
                                            }));
                                        }}
                                    >
                                        <TableCell className="py-4 pr-4 pl-0 sm:p-4 sm:pl-4">
                                            <div className="flex items-center gap-3">
                                                <img
                                                    src={asset.icon}
                                                    alt={asset.name}
                                                    className="h-8 w-8 rounded-full"
                                                />
                                                <div>
                                                    <p className="font-semibold">
                                                        {asset.id}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {asset.name}
                                                    </p>
                                                </div>
                                            </div>
                                        </TableCell>

                                        {view === "available" && (
                                            <AvailableView
                                                asset={asset}
                                                isMobile={false}
                                                isExpanded={false}
                                                availableAmount={
                                                    availableAmount
                                                }
                                                availableUsd={availableUsd}
                                                weight={weight}
                                            />
                                        )}

                                        {view === "locked" && (
                                            <LockedView
                                                asset={asset}
                                                isMobile={false}
                                                isExpanded={false}
                                                lockedAmount={lockedAmount}
                                                lockedUsd={lockedUsd}
                                                unlockedAmount={unlockedAmount}
                                                unlockedUsd={unlockedUsd}
                                                totalAllocatedAmount={
                                                    totalAllocatedAmount
                                                }
                                                totalAllocatedUsd={
                                                    totalAllocatedUsd
                                                }
                                            />
                                        )}

                                        {view === "earning" && (
                                            <EarningView
                                                asset={asset}
                                                isMobile={false}
                                                isExpanded={false}
                                                earningAmount={earningAmount}
                                                earningUsd={earningUsd}
                                                earningWithdrawAmount={
                                                    earningWithdrawAmount
                                                }
                                                earningWithdrawUsd={
                                                    earningWithdrawUsd
                                                }
                                            />
                                        )}

                                        <TableCell className="p-4 text-right hidden sm:table-cell">
                                            {isExpanded ? (
                                                <ChevronDown className="size-4 text-primary ml-auto" />
                                            ) : (
                                                <ChevronRight className="size-4 text-primary ml-auto" />
                                            )}
                                        </TableCell>
                                    </TableRow>

                                    <ExpandedRows
                                        view={view}
                                        isMobile={isMobile}
                                        isExpanded={isExpanded}
                                        asset={asset}
                                        availableNetworks={availableNetworks}
                                        lockedNetworks={lockedNetworks}
                                        earningNetworks={earningNetworks}
                                        ftLockupInstanceCount={
                                            ftLockupInstanceCount
                                        }
                                        treasuryId={treasuryId ?? null}
                                        onNavigate={(href) => router.push(href)}
                                        onSelectLockup={(network) => {
                                            setSelectedLockupNetwork(network);
                                            setIsLockupModalOpen(true);
                                        }}
                                        onSelectPool={(network, poolId) => {
                                            setSelectedStakingNetwork(network);
                                            setSelectedPoolId(poolId);
                                            setIsStakingModalOpen(true);
                                        }}
                                    />

                                    {hasLockedEarningNotice && (
                                        <TableRow className="hover:bg-transparent">
                                            <TableCell
                                                className="p-0 whitespace-normal"
                                                colSpan={6}
                                            >
                                                <div className="mb-3 mt-2 flex items-start sm:items-center gap-2 rounded-lg bg-muted/60 px-4 py-2 text-xs">
                                                    <Info className="size-4 shrink-0" />
                                                    <p className="text-foreground leading-relaxed wrap-break-word">
                                                        {isFullLockedInEarning
                                                            ? t(
                                                                  "fullAllocatedBalance",
                                                              )
                                                            : t(
                                                                  "partAllocatedBalance",
                                                              )}{" "}
                                                        {t("currentlyEarning", {
                                                            amount: formatSmartAmount(
                                                                earningFromLockedAmount,
                                                            ),
                                                            symbol: asset.id,
                                                        })}
                                                        {isFullLockedInEarning &&
                                                            t(
                                                                "willAppearHere",
                                                            )}{" "}
                                                        <button
                                                            type="button"
                                                            className="underline underline-offset-2"
                                                            onClick={(
                                                                event,
                                                            ) => {
                                                                event.stopPropagation();
                                                                setActiveView(
                                                                    "earning",
                                                                );
                                                            }}
                                                        >
                                                            {isFullLockedInEarning
                                                                ? t(
                                                                      "seeInEarningTab",
                                                                  )
                                                                : t(
                                                                      "seeInEarning",
                                                                  )}
                                                        </button>
                                                    </p>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </Fragment>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
            <EarningPoolDetailsModal
                isOpen={isStakingModalOpen}
                onClose={() => {
                    setIsStakingModalOpen(false);
                    setSelectedStakingNetwork(null);
                    setSelectedPoolId(null);
                    setSelectedMobileAsset(null);
                }}
                onBack={
                    selectedMobileAsset
                        ? () => {
                              setIsStakingModalOpen(false);
                              setSelectedStakingNetwork(null);
                              setSelectedPoolId(null);
                              setIsMobileViewModalOpen(true);
                          }
                        : undefined
                }
                asset={selectedStakingNetwork}
                poolId={selectedPoolId}
            />
            <LockupDetailsModal
                isOpen={isLockupModalOpen}
                onClose={() => {
                    setIsLockupModalOpen(false);
                    setSelectedLockupNetwork(null);
                    setSelectedMobileAsset(null);
                }}
                onBack={
                    selectedMobileAsset
                        ? () => {
                              setIsLockupModalOpen(false);
                              setSelectedLockupNetwork(null);
                              setIsMobileViewModalOpen(true);
                          }
                        : undefined
                }
                asset={selectedLockupNetwork}
                treasuryId={treasuryId ?? null}
            />
            <MobileAssetViewModal
                open={isMobileViewModalOpen}
                onOpenChange={(open) => {
                    setIsMobileViewModalOpen(open);
                    if (!open) setSelectedMobileAsset(null);
                }}
                selectedAsset={selectedMobileAsset}
                mobileModalData={mobileModalData}
                view={view}
                renderRows={renderMobileRows}
            />
        </div>
    );
}

export function AssetsTableSkeleton() {
    return (
        <Table>
            <TableHeader className="bg-transparent border-t-0">
                <TableRow className="hover:bg-transparent">
                    <TableHead className="text-muted-foreground py-4 pr-4 pl-0 sm:p-4 sm:pl-4">
                        <Skeleton className="h-4 w-full" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground p-4">
                        <Skeleton className="h-4 w-full" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground p-4">
                        <Skeleton className="h-4 w-full" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground p-4">
                        <Skeleton className="h-4 w-full" />
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {Array.from({ length: 3 }).map((_, idx) => (
                    <TableRow
                        key={`skeleton-row-${idx}`}
                        className="hover:bg-transparent"
                    >
                        <TableCell className="py-4 pr-4 pl-0 sm:p-4 sm:pl-4">
                            <Skeleton className="h-8 w-full" />
                        </TableCell>
                        <TableCell className="p-4">
                            <Skeleton className="h-8 w-full" />
                        </TableCell>
                        <TableCell className="p-4">
                            <Skeleton className="h-8 w-full" />
                        </TableCell>
                        <TableCell className="p-4">
                            <Skeleton className="h-8 w-full" />
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

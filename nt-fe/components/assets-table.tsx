"use client";
import {
    ArrowDataTransferVerticalIcon,
    ArrowDown01Icon,
    ArrowUp01Icon,
    InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/button";
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
import type { TreasuryAsset } from "@/lib/api";
import { availableBalance, lockedBalance } from "@/lib/balance";
import Big from "@/lib/big";
import { getDashboardBucketVisibility } from "@/lib/dashboard-balance-view";
import {
    cn,
    formatBalance,
    formatCurrencyWithSubCent,
    formatSmartAmount,
} from "@/lib/utils";
import { BalanceCell } from "./token-display";

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
    "inline-flex h-auto items-center gap-1.5 px-0! py-0! text-sm/5 font-medium text-gray-500 hover:bg-transparent hover:text-gray-900 dark:text-gray-400 dark:hover:bg-transparent dark:hover:text-white";

/** Rounds the row block into an inset card, like the near.com vaults table. */
const TABLE_CARD_CLASS = [
    "bg-white dark:bg-gray-850",
    "[&>tr>td]:border-gray-200 dark:[&>tr>td]:border-white/5",
    "[&>tr+tr>td]:border-t",
    "[&>tr>td:first-child]:border-l [&>tr>td:last-child]:border-r",
    "[&>tr:first-child>td]:border-t [&>tr:last-child>td]:border-b",
    "[&>tr:first-child>td:first-child]:rounded-tl-lg [&>tr:first-child>td:last-child]:rounded-tr-lg",
    "[&>tr:last-child>td:first-child]:rounded-bl-lg [&>tr:last-child>td:last-child]:rounded-br-lg",
].join(" ");

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

interface BaseAssetViewProps {
    asset: AggregatedAsset;
}

interface AvailableViewProps extends BaseAssetViewProps {
    availableAmount: Big.Big;
    availableUsd: number;
    weight: number;
}

function AvailableView({
    asset,
    availableAmount,
    availableUsd,
    weight,
}: AvailableViewProps): ReactNode {
    return (
        <>
            <TableCell className="px-3 py-3 text-right">
                <BalanceCell
                    balance={availableAmount}
                    symbol={asset.id}
                    balanceUSD={availableUsd}
                    amountFirst
                    hideSymbol
                    size="md"
                />
            </TableCell>
            <TableCell className="hidden px-3 py-3 text-right font-semibold text-base/5 text-gray-900 sm:table-cell dark:text-white">
                {formatCurrencyWithSubCent(asset.price)}
            </TableCell>
            <TableCell className="hidden px-3 py-3 text-right sm:table-cell">
                <div className="flex items-center justify-end gap-3">
                    <span className="text-right font-semibold text-base/5 text-gray-900 tabular-nums dark:text-white">
                        {weight.toFixed(2)}%
                    </span>
                    <div className="h-2 w-18 shrink-0 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                        <div
                            className="h-full rounded-full bg-gray-900 transition-all dark:bg-white"
                            style={{ width: `${weight}%` }}
                        />
                    </div>
                </div>
            </TableCell>
        </>
    );
}

interface LockedViewProps extends BaseAssetViewProps {
    lockedAmount: Big.Big;
    lockedUsd: number;
    unlockedAmount: Big.Big;
    unlockedUsd: number;
    totalAllocatedAmount: Big.Big;
    totalAllocatedUsd: number;
}

function LockedView({
    asset,
    lockedAmount,
    lockedUsd,
    unlockedAmount,
    unlockedUsd,
    totalAllocatedAmount,
    totalAllocatedUsd,
}: LockedViewProps): ReactNode {
    return (
        <>
            <TableCell className="hidden overflow-hidden px-3 py-3 text-right sm:table-cell">
                <BalanceCell
                    balance={lockedAmount}
                    symbol={asset.id}
                    balanceUSD={lockedUsd}
                    amountFirst
                    hideSymbol
                    size="md"
                />
            </TableCell>
            <TableCell className="overflow-hidden px-3 py-3 text-right">
                <BalanceCell
                    balance={unlockedAmount}
                    symbol={asset.id}
                    balanceUSD={unlockedUsd}
                    amountFirst
                    hideSymbol
                    size="md"
                />
            </TableCell>
            <TableCell className="hidden overflow-hidden px-3 py-3 text-right font-semibold text-base/5 text-gray-900 sm:table-cell dark:text-white">
                {formatCurrencyWithSubCent(asset.price)}
            </TableCell>
            <TableCell className="hidden overflow-hidden px-3 py-3 text-right sm:table-cell">
                <BalanceCell
                    balance={totalAllocatedAmount}
                    symbol={asset.id}
                    balanceUSD={totalAllocatedUsd}
                    amountFirst
                    hideSymbol
                    size="md"
                />
            </TableCell>
        </>
    );
}

interface EarningViewProps extends BaseAssetViewProps {
    earningAmount: Big.Big;
    earningUsd: number;
    earningWithdrawAmount: Big.Big;
    earningWithdrawUsd: number;
}

function EarningView({
    asset,
    earningAmount,
    earningUsd,
    earningWithdrawAmount,
    earningWithdrawUsd,
}: EarningViewProps): ReactNode {
    return (
        <>
            <TableCell className="px-3 py-3 text-right">
                <BalanceCell
                    balance={earningAmount}
                    symbol={asset.id}
                    balanceUSD={earningUsd}
                    amountFirst
                    hideSymbol
                    size="md"
                />
            </TableCell>
            <TableCell className="hidden px-3 py-3 text-right font-semibold text-base/5 text-gray-900 sm:table-cell dark:text-white">
                {formatCurrencyWithSubCent(asset.price)}
            </TableCell>
            <TableCell className="hidden px-3 py-3 text-right sm:table-cell">
                <BalanceCell
                    balance={earningWithdrawAmount}
                    symbol={asset.id}
                    balanceUSD={earningWithdrawUsd}
                    amountFirst
                    hideSymbol
                    size="md"
                />
            </TableCell>
        </>
    );
}

export function AssetsTable({ aggregatedTokens }: Props) {
    const t = useTranslations("assetsTable");
    const [sortState, setSortState] = useState<{
        key: SortKey;
        dir: SortDirection;
    }>({ key: "balance", dir: "desc" });
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
        if (activeSort.key !== key)
            return <Icon icon={ArrowDataTransferVerticalIcon} />;
        return activeSort.dir === "desc" ? (
            <Icon icon={ArrowDown01Icon} />
        ) : (
            <Icon icon={ArrowUp01Icon} />
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
                "h-auto px-3 py-2.5 font-medium text-gray-500 text-sm/5 normal-case dark:text-gray-400",
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
                                        {label}{" "}
                                        {formatCurrencyWithSubCent(value)}
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
                                    {formatCurrencyWithSubCent(value)}
                                </p>
                            </Button>
                        ))}
                    </div>
                </>
            )}

            <div className="px-1 pb-1">
                <Table className="min-w-full table-fixed border-separate border-spacing-0 divide-y divide-gray-200 dark:divide-white/10">
                    <TableHeader className="border-0 bg-transparent">
                        <TableRow className="hover:bg-transparent">
                            {renderSortableHead("token", t("columnAsset"), {
                                headClassName: cn(
                                    "overflow-hidden pr-3 pl-4 sm:pl-5",
                                    view === "locked"
                                        ? "w-[24%]"
                                        : "w-[32%] sm:w-[26%]",
                                ),
                                buttonClassName: cn("justify-start"),
                            })}
                            {view === "available" && (
                                <>
                                    {renderSortableHead(
                                        "balance",
                                        t("balance"),
                                        {
                                            headClassName:
                                                "text-right w-[22%] sm:w-[20%]",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "price",
                                        t("columnPrice"),
                                        {
                                            headClassName:
                                                "text-right w-[14%] hidden sm:table-cell",
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
                                            headClassName:
                                                "text-right w-[16%] overflow-hidden",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "unlocked",
                                        t("columnUnlocked"),
                                        {
                                            headClassName:
                                                "text-right w-[16%] overflow-hidden hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "price",
                                        t("columnPrice"),
                                        {
                                            headClassName:
                                                "text-right w-[12%] overflow-hidden hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "totalAllocated",
                                        t("columnTotalAllocated"),
                                        {
                                            headClassName:
                                                "text-right w-[16%] overflow-hidden hidden sm:table-cell",
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
                                            headClassName: "text-right w-[18%]",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "price",
                                        t("columnPrice"),
                                        {
                                            headClassName:
                                                "text-right w-[16%] hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                    {renderSortableHead(
                                        "withdrawable",
                                        t("columnAvailableToWithdraw"),
                                        {
                                            headClassName:
                                                "text-right w-[20%] hidden sm:table-cell",
                                            buttonClassName: "ml-auto",
                                        },
                                    )}
                                </>
                            )}
                            <TableHead className="w-3 p-0 sm:w-5" />
                        </TableRow>
                    </TableHeader>
                    <TableBody className={TABLE_CARD_CLASS}>
                        {viewAssets.map(({ asset, weight }) => {
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
                                    <TableRow className="hover:bg-gray-50 dark:hover:bg-white/3">
                                        <TableCell className="overflow-hidden py-3 pr-3 pl-4 sm:pl-5">
                                            <div className="flex items-center gap-3 min-w-0">
                                                <img
                                                    src={asset.icon}
                                                    alt={asset.name}
                                                    className="size-9 shrink-0 rounded-full"
                                                />
                                                <div className="min-w-0">
                                                    <p className="truncate font-semibold text-base/5 text-gray-900 dark:text-white">
                                                        {asset.id}
                                                    </p>
                                                    <p className="truncate font-medium text-gray-500 text-sm/5 dark:text-gray-400">
                                                        {asset.name}
                                                    </p>
                                                </div>
                                            </div>
                                        </TableCell>

                                        {view === "available" && (
                                            <AvailableView
                                                asset={asset}
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

                                        <TableCell className="p-0" />
                                    </TableRow>

                                    {hasLockedEarningNotice && (
                                        <TableRow className="hover:bg-transparent">
                                            <TableCell
                                                className="p-0 whitespace-normal"
                                                colSpan={6}
                                            >
                                                <div className="mb-3 mt-2 flex items-start sm:items-center gap-2 rounded-lg bg-muted/60 px-4 py-2 text-xs">
                                                    <Icon
                                                        icon={
                                                            InformationCircleIcon
                                                        }
                                                        className="shrink-0"
                                                    />
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

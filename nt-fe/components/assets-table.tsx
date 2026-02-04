"use client";

import { Fragment, useMemo, useState } from "react";
import {
    ArrowUpDown,
    ChevronDown,
    ChevronUp,
    ChevronRight,
    Lock,
    ArrowUpRight,
    Info,
    Send,
    RefreshCw,
    ArrowLeftRight,
} from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    flexRender,
    createColumnHelper,
    SortingState,
    ColumnDef,
    getExpandedRowModel,
    ExpandedState,
} from "@tanstack/react-table";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { Button } from "@/components/button";
import { TreasuryAsset } from "@/lib/api";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import { useAggregatedTokens, AggregatedAsset } from "@/hooks/use-assets";
import Big from "big.js";
import { NetworkDisplay, BalanceCell } from "./token-display";
import { availableBalance, totalBalance, lockedBalance } from "@/lib/balance";
import { VestingDetailsModal } from "./vesting-details-modal";
import { EarningDetailsModal } from "./earning-details-modal";
import { Tooltip } from "./tooltip";
import { useTreasury } from "@/hooks/use-treasury";

const columnHelper = createColumnHelper<AggregatedAsset>();

interface Props {
    tokens: TreasuryAsset[];
}

export function AssetsTable({ tokens }: Props) {
    const [sorting, setSorting] = useState<SortingState>([
        { id: "totalBalanceUSD", desc: true },
    ]);
    const { treasuryId } = useTreasury();
    const [expanded, setExpanded] = useState<ExpandedState>({});
    const [selectedVestingNetwork, setSelectedVestingNetwork] =
        useState<TreasuryAsset | null>(null);
    const [isVestingModalOpen, setIsVestingModalOpen] = useState(false);
    const [selectedStakingNetwork, setSelectedStakingNetwork] =
        useState<TreasuryAsset | null>(null);
    const [isStakingModalOpen, setIsStakingModalOpen] = useState(false);

    // Aggregate tokens by symbol using custom hook
    const aggregatedTokens = useAggregatedTokens(tokens);

    // Define columns
    const columns = useMemo<ColumnDef<AggregatedAsset, any>[]>(
        () => [
            columnHelper.accessor("symbol", {
                header: "Token",
                cell: (info) => {
                    const asset = info.row.original;
                    const isPartiallyLocked = asset.networks.some((token) =>
                        lockedBalance(token.balance).gt(0),
                    );
                    return (
                        <div className="flex items-center gap-3">
                            {asset.icon.startsWith("data:image") ||
                            asset.icon.startsWith("http") ? (
                                <img
                                    src={asset.icon}
                                    alt={asset.symbol}
                                    className="h-10 w-10 rounded-full"
                                />
                            ) : (
                                <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-xl shrink-0">
                                    {asset.icon}
                                </div>
                            )}
                            <div>
                                <div className="font-semibold flex gap-2">
                                    {asset.symbol}
                                    {isPartiallyLocked && (
                                        <div className="flex gap-1.5 px-1 py-0.5 bg-secondary rounded-[4px] text-secondary-foreground font-medium">
                                            <Lock className="size-2.5 shrink-0 mt-0.5" />
                                            <span className="text-xxs">
                                                Partially Locked
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {asset.name}
                                </div>
                            </div>
                        </div>
                    );
                },
            }),
            columnHelper.accessor("totalBalanceUSD", {
                header: "Balance",
                cell: (info) => {
                    const asset = info.row.original;
                    return (
                        <BalanceCell
                            balance={asset.totalBalance}
                            symbol={asset.symbol}
                            balanceUSD={asset.totalBalanceUSD}
                        />
                    );
                },
            }),
            columnHelper.accessor("price", {
                header: "Coin Price",
                cell: (info) => (
                    <div className="text-right font-medium">
                        {formatCurrency(info.getValue())}
                    </div>
                ),
            }),
            columnHelper.accessor("weight", {
                header: "Weight",
                cell: (info) => {
                    const weight = info.getValue();
                    return (
                        <div className="flex items-center justify-end gap-3">
                            <div className="flex-1 max-w-[100px] bg-muted rounded-full h-2 overflow-hidden">
                                <div
                                    className="bg-primary h-full rounded-full transition-all"
                                    style={{ width: `${weight}%` }}
                                />
                            </div>
                            <div className="font-medium w-16 text-right">
                                {weight.toFixed(2)}%
                            </div>
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "expand",
                cell: ({ row }) => {
                    return (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                                e.stopPropagation();
                                row.toggleExpanded();
                            }}
                            className="h-8 w-8 p-0"
                        >
                            {row.getIsExpanded() ? (
                                <ChevronDown className="h-4 w-4 text-primary" />
                            ) : (
                                <ChevronRight className="h-4 w-4 text-primary" />
                            )}
                        </Button>
                    );
                },
            }),
        ],
        [],
    );

    const table = useReactTable({
        data: aggregatedTokens,
        columns,
        state: {
            sorting,
            expanded,
        },
        onSortingChange: setSorting,
        onExpandedChange: setExpanded,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getExpandedRowModel: getExpandedRowModel(),
        enableSortingRemoval: false,
        getRowId: (row) => row.symbol,
    });

    if (tokens.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No assets found.
            </div>
        );
    }

    return (
        <Table>
            <TableHeader className="bg-transparent border-t-0">
                {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow
                        key={headerGroup.id}
                        className="hover:bg-transparent"
                    >
                        {headerGroup.headers.map((header) => (
                            <TableHead
                                key={header.id}
                                className={cn(
                                    header.id !== "symbol" &&
                                        header.id !== "expand"
                                        ? "text-right text-muted-foreground"
                                        : "text-muted-foreground",
                                )}
                            >
                                {header.isPlaceholder ? null : header.id ===
                                  "expand" ? null : (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={header.column.getToggleSortingHandler()}
                                        className={cn(
                                            "flex items-center gap-1 px-0 hover:bg-transparent uppercase text-xxs",
                                            header.id !== "symbol"
                                                ? "ml-auto"
                                                : "",
                                        )}
                                    >
                                        {flexRender(
                                            header.column.columnDef.header,
                                            header.getContext(),
                                        )}
                                        {header.column.getIsSorted() ===
                                        "desc" ? (
                                            <ChevronDown className="size-3" />
                                        ) : header.column.getIsSorted() ===
                                          "asc" ? (
                                            <ChevronUp className="size-3" />
                                        ) : (
                                            <ArrowUpDown className="size-3" />
                                        )}
                                    </Button>
                                )}
                            </TableHead>
                        ))}
                    </TableRow>
                ))}
            </TableHeader>
            <TableBody>
                {table.getRowModel().rows.map((row) => (
                    <Fragment key={row.id}>
                        <TableRow
                            onClick={() => {
                                row.toggleExpanded();
                            }}
                            className="cursor-pointer"
                        >
                            {row.getVisibleCells().map((cell) => (
                                <TableCell key={cell.id} className="p-4">
                                    {flexRender(
                                        cell.column.columnDef.cell,
                                        cell.getContext(),
                                    )}
                                </TableCell>
                            ))}
                        </TableRow>
                        {row.getIsExpanded() && (
                            <>
                                {(() => {
                                    const sourceNetworks =
                                        row.original.networks.filter(
                                            (n) =>
                                                n.residency !== "Lockup" &&
                                                n.residency !== "Staked",
                                        );
                                    const stakingNetworks =
                                        row.original.networks.filter(
                                            (n) => n.residency === "Staked",
                                        );
                                    const vestingNetworks =
                                        row.original.networks.filter(
                                            (n) => n.residency === "Lockup",
                                        );

                                    const calculateBalanceUSD = (
                                        balance: Big,
                                        price: number,
                                        decimals: number,
                                    ) => {
                                        const decimalAdjusted = balance.div(
                                            Big(10).pow(decimals),
                                        );
                                        return decimalAdjusted
                                            .mul(price)
                                            .toNumber();
                                    };

                                    return (
                                        <>
                                            {/* SOURCE Section */}
                                            {sourceNetworks.length > 0 && (
                                                <>
                                                    <TableRow className="bg-muted/30 uppercase text-muted-foreground font-medium hover:bg-muted/30">
                                                        <TableCell className="p-2 pl-16 text-xxs">
                                                            Source
                                                        </TableCell>
                                                        <TableCell className="p-2"></TableCell>
                                                        <TableCell className="p-2 text-right text-xxs">
                                                            Available to Use
                                                        </TableCell>
                                                        <TableCell className="p-2 text-xxs flex items-center justify-end gap-1">
                                                            Frozen{" "}
                                                            <Tooltip content="Frozen tokens are locked and cannot be used. They might be locked due to being used for storage, staked, or not yet vested.">
                                                                <Info className="size-3 shrink-0" />
                                                            </Tooltip>
                                                        </TableCell>
                                                        <TableCell className="p-2"></TableCell>
                                                    </TableRow>
                                                    {sourceNetworks.map(
                                                        (network, idx) => {
                                                            const total =
                                                                totalBalance(
                                                                    network.balance,
                                                                );
                                                            const available =
                                                                availableBalance(
                                                                    network.balance,
                                                                );
                                                            const locked =
                                                                lockedBalance(
                                                                    network.balance,
                                                                );
                                                            const tokenParam =
                                                                encodeURIComponent(
                                                                    JSON.stringify(
                                                                        {
                                                                            symbol: network.symbol,
                                                                            address:
                                                                                network.id,
                                                                            network:
                                                                                network.network,
                                                                            decimals:
                                                                                network.decimals,
                                                                            icon: network.icon,
                                                                            name: network.name,
                                                                        },
                                                                    ),
                                                                );
                                                            return (
                                                                <TableRow
                                                                    key={`${row.id}-source-${idx}`}
                                                                    className="bg-muted/30 group"
                                                                >
                                                                    <TableCell className="p-4 pl-16">
                                                                        <NetworkDisplay
                                                                            asset={
                                                                                network
                                                                            }
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <BalanceCell
                                                                            balance={Big(
                                                                                formatBalance(
                                                                                    total,
                                                                                    network.decimals,
                                                                                ),
                                                                            )}
                                                                            symbol={
                                                                                network.symbol
                                                                            }
                                                                            balanceUSD={calculateBalanceUSD(
                                                                                total,
                                                                                network.price,
                                                                                network.decimals,
                                                                            )}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        {locked.gt(
                                                                            0,
                                                                        ) && (
                                                                            <BalanceCell
                                                                                balance={Big(
                                                                                    formatBalance(
                                                                                        available,
                                                                                        network.decimals,
                                                                                    ),
                                                                                )}
                                                                                symbol={
                                                                                    network.symbol
                                                                                }
                                                                                balanceUSD={calculateBalanceUSD(
                                                                                    available,
                                                                                    network.price,
                                                                                    network.decimals,
                                                                                )}
                                                                            />
                                                                        )}
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <div className="relative">
                                                                            <div className="group-hover:opacity-0 transition-opacity">
                                                                                {locked.gt(
                                                                                    0,
                                                                                ) && (
                                                                                    <BalanceCell
                                                                                        balance={Big(
                                                                                            formatBalance(
                                                                                                locked,
                                                                                                network.decimals,
                                                                                            ),
                                                                                        )}
                                                                                        symbol={
                                                                                            network.symbol
                                                                                        }
                                                                                        balanceUSD={calculateBalanceUSD(
                                                                                            locked,
                                                                                            network.price,
                                                                                            network.decimals,
                                                                                        )}
                                                                                    />
                                                                                )}
                                                                            </div>
                                                                            <div className="absolute inset-0 flex gap-1 justify-end items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                <Link
                                                                                    href={`/${treasuryId}/payments?token=${tokenParam}`}
                                                                                    onClick={(
                                                                                        e,
                                                                                    ) =>
                                                                                        e.stopPropagation()
                                                                                    }
                                                                                >
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="icon"
                                                                                        className="h-8 w-8"
                                                                                        tooltipContent="Send"
                                                                                    >
                                                                                        <ArrowUpRight className="size-4 text-primary" />
                                                                                    </Button>
                                                                                </Link>
                                                                                <Link
                                                                                    href={`/${treasuryId}/exchange?sellToken=${tokenParam}`}
                                                                                    onClick={(
                                                                                        e,
                                                                                    ) =>
                                                                                        e.stopPropagation()
                                                                                    }
                                                                                >
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="icon"
                                                                                        className="h-8 w-8"
                                                                                        tooltipContent="Exchange"
                                                                                    >
                                                                                        <ArrowLeftRight className="size-4 text-primary" />
                                                                                    </Button>
                                                                                </Link>
                                                                            </div>
                                                                        </div>
                                                                    </TableCell>
                                                                    <TableCell className="p-4"></TableCell>
                                                                </TableRow>
                                                            );
                                                        },
                                                    )}
                                                </>
                                            )}

                                            {/* STAKING Section */}
                                            {stakingNetworks.length > 0 && (
                                                <>
                                                    {stakingNetworks.map(
                                                        (network, idx) => {
                                                            const total =
                                                                totalBalance(
                                                                    network.balance,
                                                                );
                                                            const available =
                                                                availableBalance(
                                                                    network.balance,
                                                                );
                                                            const locked =
                                                                lockedBalance(
                                                                    network.balance,
                                                                );
                                                            return (
                                                                <TableRow
                                                                    key={`${row.id}-staking-${idx}`}
                                                                    className="bg-muted/30 group cursor-pointer"
                                                                    onClick={() => {
                                                                        setSelectedStakingNetwork(
                                                                            network,
                                                                        );
                                                                        setIsStakingModalOpen(
                                                                            true,
                                                                        );
                                                                    }}
                                                                >
                                                                    <TableCell className="p-4 pl-16">
                                                                        <NetworkDisplay
                                                                            asset={
                                                                                network
                                                                            }
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <BalanceCell
                                                                            balance={Big(
                                                                                formatBalance(
                                                                                    total,
                                                                                    network.decimals,
                                                                                ),
                                                                            )}
                                                                            symbol={
                                                                                network.symbol
                                                                            }
                                                                            balanceUSD={calculateBalanceUSD(
                                                                                total,
                                                                                network.price,
                                                                                network.decimals,
                                                                            )}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <BalanceCell
                                                                            balance={Big(
                                                                                formatBalance(
                                                                                    available,
                                                                                    network.decimals,
                                                                                ),
                                                                            )}
                                                                            symbol={
                                                                                network.symbol
                                                                            }
                                                                            balanceUSD={calculateBalanceUSD(
                                                                                available,
                                                                                network.price,
                                                                                network.decimals,
                                                                            )}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <div className="relative">
                                                                            <div className="group-hover:opacity-0 transition-opacity">
                                                                                <BalanceCell
                                                                                    balance={Big(
                                                                                        formatBalance(
                                                                                            locked,
                                                                                            network.decimals,
                                                                                        ),
                                                                                    )}
                                                                                    symbol={
                                                                                        network.symbol
                                                                                    }
                                                                                    balanceUSD={calculateBalanceUSD(
                                                                                        locked,
                                                                                        network.price,
                                                                                        network.decimals,
                                                                                    )}
                                                                                />
                                                                            </div>
                                                                            <div className="absolute inset-0 flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                <Button
                                                                                    variant="ghost"
                                                                                    size="icon"
                                                                                    className="h-8 w-8"
                                                                                    onClick={(
                                                                                        e,
                                                                                    ) => {
                                                                                        e.stopPropagation();
                                                                                        setSelectedStakingNetwork(
                                                                                            network,
                                                                                        );
                                                                                        setIsStakingModalOpen(
                                                                                            true,
                                                                                        );
                                                                                    }}
                                                                                >
                                                                                    <ChevronRight className="size-4 text-primary" />
                                                                                </Button>
                                                                            </div>
                                                                        </div>
                                                                    </TableCell>
                                                                    <TableCell className="p-4"></TableCell>
                                                                </TableRow>
                                                            );
                                                        },
                                                    )}
                                                </>
                                            )}

                                            {/* VESTING Section */}
                                            {vestingNetworks.length > 0 && (
                                                <>
                                                    <TableRow className="bg-muted/30 uppercase text-muted-foreground font-medium hover:bg-muted/30">
                                                        <TableCell className="p-2 pl-16 flex gap-2 items-center text-xxs">
                                                            Vesting{" "}
                                                            <Lock className="size-3 shrink-0" />
                                                        </TableCell>
                                                        <TableCell className="p-2"></TableCell>
                                                        <TableCell className="p-2"></TableCell>
                                                        <TableCell className="p-2 text-right text-xxs">
                                                            {(() => {
                                                                const vestingNetwork =
                                                                    vestingNetworks[0];
                                                                if (
                                                                    vestingNetwork
                                                                        .balance
                                                                        .type ===
                                                                    "Vested"
                                                                ) {
                                                                    const {
                                                                        totalAllocated,
                                                                        unvested,
                                                                    } =
                                                                        vestingNetwork
                                                                            .balance
                                                                            .lockup;
                                                                    const vestedPercent =
                                                                        totalAllocated.gt(
                                                                            0,
                                                                        )
                                                                            ? totalAllocated
                                                                                  .sub(
                                                                                      unvested,
                                                                                  )
                                                                                  .div(
                                                                                      totalAllocated,
                                                                                  )
                                                                                  .mul(
                                                                                      100,
                                                                                  )
                                                                                  .toNumber()
                                                                            : 0;
                                                                    return (
                                                                        <div className="flex items-center justify-end gap-2">
                                                                            <div className="w-20 bg-muted rounded-full h-1.5 overflow-hidden">
                                                                                <div
                                                                                    className="bg-primary h-full rounded-full transition-all"
                                                                                    style={{
                                                                                        width: `${vestedPercent}%`,
                                                                                    }}
                                                                                />
                                                                            </div>
                                                                            <span className="text-xxs text-muted-foreground">
                                                                                {vestedPercent.toFixed(
                                                                                    0,
                                                                                )}
                                                                                %
                                                                                Vested
                                                                            </span>
                                                                        </div>
                                                                    );
                                                                }
                                                                return null;
                                                            })()}
                                                        </TableCell>
                                                        <TableCell className="p-2"></TableCell>
                                                    </TableRow>
                                                    {vestingNetworks.map(
                                                        (network, idx) => {
                                                            const total =
                                                                totalBalance(
                                                                    network.balance,
                                                                );
                                                            const available =
                                                                availableBalance(
                                                                    network.balance,
                                                                );
                                                            const locked =
                                                                lockedBalance(
                                                                    network.balance,
                                                                );
                                                            return (
                                                                <TableRow
                                                                    key={`${row.id}-vesting-${idx}`}
                                                                    className="bg-muted/30 group cursor-pointer"
                                                                    onClick={() => {
                                                                        setSelectedVestingNetwork(
                                                                            network,
                                                                        );
                                                                        setIsVestingModalOpen(
                                                                            true,
                                                                        );
                                                                    }}
                                                                >
                                                                    <TableCell className="p-4 pl-16">
                                                                        <NetworkDisplay
                                                                            asset={
                                                                                network
                                                                            }
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <BalanceCell
                                                                            balance={Big(
                                                                                formatBalance(
                                                                                    total,
                                                                                    network.decimals,
                                                                                ),
                                                                            )}
                                                                            symbol={
                                                                                network.symbol
                                                                            }
                                                                            balanceUSD={calculateBalanceUSD(
                                                                                total,
                                                                                network.price,
                                                                                network.decimals,
                                                                            )}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <BalanceCell
                                                                            balance={Big(
                                                                                formatBalance(
                                                                                    available,
                                                                                    network.decimals,
                                                                                ),
                                                                            )}
                                                                            symbol={
                                                                                network.symbol
                                                                            }
                                                                            balanceUSD={calculateBalanceUSD(
                                                                                available,
                                                                                network.price,
                                                                                network.decimals,
                                                                            )}
                                                                        />
                                                                    </TableCell>
                                                                    <TableCell className="p-4">
                                                                        <div className="relative">
                                                                            <div className="group-hover:opacity-0 transition-opacity">
                                                                                <BalanceCell
                                                                                    balance={Big(
                                                                                        formatBalance(
                                                                                            locked,
                                                                                            network.decimals,
                                                                                        ),
                                                                                    )}
                                                                                    symbol={
                                                                                        network.symbol
                                                                                    }
                                                                                    balanceUSD={calculateBalanceUSD(
                                                                                        locked,
                                                                                        network.price,
                                                                                        network.decimals,
                                                                                    )}
                                                                                />
                                                                            </div>
                                                                            <div className="absolute inset-0 flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                <Button
                                                                                    variant="ghost"
                                                                                    size="icon"
                                                                                    className="h-8 w-8"
                                                                                    disabled
                                                                                    tooltipContent="Coming soon"
                                                                                    onClick={(
                                                                                        e,
                                                                                    ) =>
                                                                                        e.stopPropagation()
                                                                                    }
                                                                                >
                                                                                    <ArrowUpRight className="size-4 text-primary" />
                                                                                </Button>
                                                                                <Button
                                                                                    variant="ghost"
                                                                                    size="icon"
                                                                                    className="h-8 w-8"
                                                                                    onClick={(
                                                                                        e,
                                                                                    ) => {
                                                                                        e.stopPropagation();
                                                                                        setSelectedVestingNetwork(
                                                                                            network,
                                                                                        );
                                                                                        setIsVestingModalOpen(
                                                                                            true,
                                                                                        );
                                                                                    }}
                                                                                >
                                                                                    <ChevronRight className="size-4 text-primary" />
                                                                                </Button>
                                                                            </div>
                                                                        </div>
                                                                    </TableCell>
                                                                    <TableCell className="p-4"></TableCell>
                                                                </TableRow>
                                                            );
                                                        },
                                                    )}
                                                </>
                                            )}
                                        </>
                                    );
                                })()}
                            </>
                        )}
                    </Fragment>
                ))}
            </TableBody>
            <VestingDetailsModal
                isOpen={isVestingModalOpen}
                onClose={() => {
                    setIsVestingModalOpen(false);
                    setSelectedVestingNetwork(null);
                }}
                asset={selectedVestingNetwork ?? null}
                treasuryId={treasuryId ?? null}
            />
            <EarningDetailsModal
                isOpen={isStakingModalOpen}
                onClose={() => {
                    setIsStakingModalOpen(false);
                    setSelectedStakingNetwork(null);
                }}
                asset={selectedStakingNetwork ?? null}
            />
        </Table>
    );
}

export function AssetsTableSkeleton() {
    return (
        <Table>
            <TableHeader className="bg-transparent border-t-0">
                <TableRow className="hover:bg-transparent">
                    <TableHead className="text-muted-foreground">
                        <Skeleton className="h-4 w-12" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                        <Skeleton className="h-4 w-16 ml-auto" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                        <Skeleton className="h-4 w-16 ml-auto" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                        <Skeleton className="h-4 w-16 ml-auto" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                        <Skeleton className="h-4 w-20 ml-auto" />
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                        <Skeleton className="h-4 w-14 ml-auto" />
                    </TableHead>
                    <TableHead />
                </TableRow>
            </TableHeader>
            <TableBody>
                {Array.from({ length: 4 }).map((_, index) => (
                    <TableRow key={index}>
                        <TableCell className="p-4">
                            <div className="flex items-center gap-3">
                                <Skeleton className="h-10 w-10 rounded-full" />
                                <div>
                                    <Skeleton className="h-4 w-16 mb-1" />
                                    <Skeleton className="h-3 w-24" />
                                </div>
                            </div>
                        </TableCell>
                        <TableCell className="p-4">
                            <div className="flex flex-col items-end">
                                <Skeleton className="h-4 w-20 mb-1" />
                                <Skeleton className="h-3 w-16" />
                            </div>
                        </TableCell>
                        <TableCell className="p-4">
                            <div className="flex flex-col items-end">
                                <Skeleton className="h-4 w-16 mb-1" />
                                <Skeleton className="h-3 w-12" />
                            </div>
                        </TableCell>
                        <TableCell className="p-4">
                            <div className="flex flex-col items-end">
                                <Skeleton className="h-4 w-16 mb-1" />
                                <Skeleton className="h-3 w-12" />
                            </div>
                        </TableCell>
                        <TableCell className="p-4">
                            <Skeleton className="h-4 w-16 ml-auto" />
                        </TableCell>
                        <TableCell className="p-4">
                            <div className="flex items-center justify-end gap-3">
                                <Skeleton className="h-2 w-[100px] rounded-full" />
                                <Skeleton className="h-4 w-12" />
                            </div>
                        </TableCell>
                        <TableCell className="p-4">
                            <Skeleton className="h-8 w-8 rounded" />
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

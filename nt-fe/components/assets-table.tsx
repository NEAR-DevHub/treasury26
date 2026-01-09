"use client";

import { Fragment, useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, ChevronUp, ChevronRight } from "lucide-react";
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
import { formatBalance, formatCurrency } from "@/lib/utils";
import { useAggregatedTokens, AggregatedAsset } from "@/hooks/use-aggregated-tokens";
import Big from "big.js";
import { NetworkDisplay, BalanceCell } from "./token-display";

const columnHelper = createColumnHelper<AggregatedAsset>();

interface Props {
  tokens: TreasuryAsset[];
}

export function AssetsTable({ tokens }: Props) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "totalBalanceUSD", desc: true },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  // Aggregate tokens by symbol using custom hook
  const aggregatedTokens = useAggregatedTokens(tokens);

  // Define columns
  const columns = useMemo<ColumnDef<AggregatedAsset, any>[]>(
    () => [
      columnHelper.accessor("symbol", {
        header: "Token",
        cell: (info) => {
          const asset = info.row.original;
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
                <div className="font-semibold">{asset.symbol}</div>
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
          return <BalanceCell balance={asset.totalBalance} symbol={asset.symbol} balanceUSD={asset.totalBalanceUSD} />;
        },
      }),
      columnHelper.accessor("price", {
        header: "Coin Price",
        cell: (info) => (
          <div className="text-right">{formatCurrency(info.getValue())}</div>
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
                  className="bg-blue-500 h-full rounded-full transition-all"
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
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          );
        },
      }),
    ],
    []
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
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className="hover:bg-transparent">
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className={
                  header.id !== "symbol" && header.id !== "expand"
                    ? "text-right text-muted-foreground"
                    : "text-muted-foreground"
                }
              >
                {header.isPlaceholder ? null : header.id === "expand" ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={header.column.getToggleSortingHandler()}
                    className={`flex items-center gap-1 px-0 hover:bg-transparent ${header.id !== "symbol" ? "ml-auto" : ""
                      }`}
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                    {header.column.getIsSorted() === "desc" ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : header.column.getIsSorted() === "asc" ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ArrowUpDown className="h-4 w-4" />
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
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
            {row.getIsExpanded() && (
              <>
                {row.original.networks.map((network, idx) => (
                  <TableRow key={`${row.id}-${idx}`} className="bg-muted/30">
                    <TableCell className="p-4 pl-16">
                      <NetworkDisplay asset={network} />
                    </TableCell>
                    <TableCell className="p-4">
                      <BalanceCell balance={Big(formatBalance(network.balance.toString(), network.decimals))} symbol={network.symbol} balanceUSD={network.balanceUSD} />
                    </TableCell>
                    <TableCell className="p-4 text-right text-muted-foreground">-</TableCell>
                    <TableCell className="p-4 text-right text-muted-foreground">-</TableCell>
                    <TableCell className="p-4"></TableCell>
                  </TableRow>
                ))}
              </>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

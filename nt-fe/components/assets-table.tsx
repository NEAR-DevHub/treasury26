"use client";

import { useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
  ColumnDef,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/button";
import { TreasuryAsset } from "@/lib/api";
import { formatBalance } from "@/lib/utils";

const columnHelper = createColumnHelper<TreasuryAsset>();

interface Props {
  tokens: TreasuryAsset[];
}

export function AssetsTable({ tokens }: Props) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "balanceUSD", desc: true },
  ]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  };

  const formatNumber = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  // Define columns
  const columns = useMemo<ColumnDef<TreasuryAsset, any>[]>(
    () => [
      columnHelper.accessor("symbol", {
        header: "Token",
        cell: (info) => {
          const token = info.row.original;
          return (
            <div className="flex items-center gap-3">
              {token.icon.startsWith("data:image") ||
                token.icon.startsWith("http") ? (
                <img
                  src={token.icon}
                  alt={token.symbol}
                  className="h-10 w-10 rounded-full"
                />
              ) : (
                <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-xl shrink-0">
                  {token.icon}
                </div>
              )}
              <div>
                <div className="font-semibold">{token.symbol}</div>
                <div className="text-xs text-muted-foreground">
                  {token.name}
                </div>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor("balanceUSD", {
        header: "Balance",
        cell: (info) => {
          const token = info.row.original;
          return (
            <div className="text-right">
              <div className="font-semibold">
                {formatCurrency(token.balanceUSD)}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatBalance(token.balance, token.decimals)} {token.symbol}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor("price", {
        header: "Price",
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
    ],
    []
  );

  const table = useReactTable({
    data: tokens,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableSortingRemoval: false,
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
                  header.id !== "symbol"
                    ? "text-right text-muted-foreground"
                    : "text-muted-foreground"
                }
              >
                {header.isPlaceholder ? null : (
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
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className="p-4">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

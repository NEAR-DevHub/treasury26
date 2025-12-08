"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ArrowUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

interface Asset {
  symbol: string;
  name: string;
  icon: string;
  balance: number;
  balanceUSD: number;
  price: number;
  weight: number;
  networks?: { name: string; balance: number; unit: string }[];
}

const MOCK_ASSETS: Asset[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    icon: "💵",
    balance: 20000,
    balanceUSD: 20000,
    price: 1.0,
    weight: 44.05,
    networks: [{ name: "NEAR", balance: 20000, unit: "USDC" }],
  },
  {
    symbol: "DAI",
    name: "Dai",
    icon: "💰",
    balance: 15400,
    balanceUSD: 15400,
    price: 1.0,
    weight: 33.92,
  },
  {
    symbol: "NEAR",
    name: "NEAR Protocol",
    icon: "🔷",
    balance: 4694.84,
    balanceUSD: 10000.01,
    price: 2.13,
    weight: 22.03,
  },
];

type SortField = "symbol" | "balance" | "price" | "weight";
type SortDirection = "asc" | "desc" | null;

export function AssetsTable() {
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("balance");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDirection === "desc") {
        setSortDirection("asc");
      } else if (sortDirection === "asc") {
        setSortDirection(null);
        setSortField("balance");
      }
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const sortedAssets = [...MOCK_ASSETS].sort((a, b) => {
    if (!sortDirection) return 0;

    let aValue = a[sortField];
    let bValue = b[sortField];

    if (sortField === "symbol") {
      aValue = (aValue as string).toLowerCase();
      bValue = (bValue as string).toLowerCase();
    }

    if (aValue < bValue) return sortDirection === "asc" ? -1 : 1;
    if (aValue > bValue) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  const toggleExpand = (symbol: string) => {
    setExpandedAsset(expandedAsset === symbol ? null : symbol);
  };

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

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4" />;
    }
    if (sortDirection === "asc") {
      return <ChevronUp className="h-4 w-4" />;
    }
    return <ChevronDown className="h-4 w-4" />;
  };

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-6 border-b">
        <h2 className="text-lg font-semibold">Assets</h2>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSort("symbol")}
                className="flex items-center gap-1 px-0 hover:bg-transparent"
              >
                Token <SortIcon field="symbol" />
              </Button>
            </TableHead>
            <TableHead className="text-right text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSort("balance")}
                className="flex items-center gap-1 ml-auto hover:bg-transparent"
              >
                Balance <SortIcon field="balance" />
              </Button>
            </TableHead>
            <TableHead className="text-right text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSort("price")}
                className="flex items-center gap-1 ml-auto hover:bg-transparent"
              >
                Price <SortIcon field="price" />
              </Button>
            </TableHead>
            <TableHead className="text-right text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSort("weight")}
                className="flex items-center gap-1 ml-auto hover:bg-transparent"
              >
                Weight <SortIcon field="weight" />
              </Button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedAssets.map((asset) => (
            <>
              <TableRow
                key={asset.symbol}
                className={asset.networks ? "cursor-pointer" : ""}
                onClick={() => asset.networks && toggleExpand(asset.symbol)}
              >
                <TableCell className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-xl shrink-0">
                      {asset.icon}
                    </div>
                    <div>
                      <div className="font-semibold">{asset.symbol}</div>
                      <div className="text-xs text-muted-foreground">{asset.name}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="p-4 text-right">
                  <div className="font-semibold">
                    {formatCurrency(asset.balanceUSD)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatNumber(asset.balance)} {asset.symbol}
                  </div>
                </TableCell>
                <TableCell className="p-4 text-right">
                  <div>{formatCurrency(asset.price)}</div>
                </TableCell>
                <TableCell className="p-4 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <div className="flex-1 max-w-[100px] bg-muted rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-500 h-full rounded-full transition-all"
                        style={{ width: `${asset.weight}%` }}
                      />
                    </div>
                    <div className="font-medium w-16 text-right">
                      {asset.weight.toFixed(2)}%
                    </div>
                    {asset.networks && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(asset.symbol);
                        }}
                      >
                        {expandedAsset === asset.symbol ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
              {asset.networks && expandedAsset === asset.symbol && (
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={4} className="p-4">
                    <div className="pl-16">
                      <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                        Balance by Network
                      </div>
                      {asset.networks.map((network) => (
                        <div
                          key={network.name}
                          className="flex items-center justify-between py-2"
                        >
                          <div className="flex items-center gap-2">
                            <div className="h-6 w-6 rounded-full bg-green-600 flex items-center justify-center">
                              <span className="text-xs">🔷</span>
                            </div>
                            <span className="text-sm">{network.name}</span>
                          </div>
                          <span className="text-sm">
                            {formatNumber(network.balance)} {network.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

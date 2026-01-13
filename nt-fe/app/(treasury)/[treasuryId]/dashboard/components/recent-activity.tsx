"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowDownToLine, ArrowUpToLine, Upload } from "lucide-react";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { cn } from "@/lib/utils";
import { useState, useEffect, useMemo } from "react";
import type { RecentActivity as RecentActivityType } from "@/lib/api";
import { TransactionDetailsModal } from "./transaction-details-modal";
import { ExportActivityModal } from "./export-activity-modal";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  ColumnDef,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/table";
import { FormattedDate } from "@/components/formatted-date";

const ITEMS_PER_PAGE = 10;

const columnHelper = createColumnHelper<RecentActivityType>();

export function RecentActivity() {
  const { selectedTreasury: treasuryId } = useTreasury();
  const [page, setPage] = useState(0);
  const [allActivities, setAllActivities] = useState<RecentActivityType[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedActivity, setSelectedActivity] = useState<RecentActivityType | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  
  const { data: response, isLoading, isFetching } = useRecentActivity(
    treasuryId,
    ITEMS_PER_PAGE,
    page * ITEMS_PER_PAGE
  );

  // Accumulate activities as we paginate
  useEffect(() => {
    if (response) {
      setTotal(response.total);
      
      if (page === 0) {
        // First page - replace all
        setAllActivities(response.data);
      } else {
        // Subsequent pages - append
        setAllActivities(prev => {
          const existingIds = new Set(prev.map(a => a.id));
          const newActivities = response.data.filter(a => !existingIds.has(a.id));
          return [...prev, ...newActivities];
        });
      }
    }
  }, [response, page]);

  const hasMore = allActivities.length < total;

  const formatAmount = (amount: string, decimals: number) => {
    const num = parseFloat(amount);
    const absNum = Math.abs(num);
    const sign = num >= 0 ? "+" : "-";

    const decimalPlaces = absNum >= 1 ? 2 : Math.min(6, decimals);

    return `${sign}${absNum.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: decimalPlaces,
    })}`;
  };

  const getActivityType = (amount: string) => {
    const isReceived = parseFloat(amount) > 0;
    return isReceived ? "Payment Received" : "Payment Sent";
  };

  const getActivityFrom = (
    amount: string,
    counterparty: string | null,
    receiverId: string | null
  ) => {
    const isReceived = parseFloat(amount) > 0;
    
    // If received → show "From counterparty"
    if (isReceived && counterparty) {
      return `from ${counterparty}`;
    }
    
    // If sent → show "To receiver"
    if (!isReceived && receiverId) {
      return `to ${receiverId}`;
    }

    return isReceived ? `from ${counterparty || "unknown"}` : `to ${receiverId || "unknown"}`;
  };

  const handleActivityClick = (activity: RecentActivityType) => {
    setSelectedActivity(activity);
    setIsModalOpen(true);
  };

  const handleToggleShowAll = () => {
    if (!isFetching && hasMore) {
      setPage(prev => prev + 1);
    }
  };

  const columns = useMemo<ColumnDef<RecentActivityType, any>[]>(
    () => [
      columnHelper.display({
        id: "type",
        header: "",
        cell: ({ row }) => {
          const activity = row.original;
          const isReceived = parseFloat(activity.amount) > 0;
          const activityType = getActivityType(activity.amount);

          return (
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full shrink-0",
                  isReceived
                    ? "bg-general-success-background-faded"
                    : "bg-general-destructive-background-faded"
                )}
              >
                {isReceived ? (
                  <ArrowDownToLine className="h-5 w-5 text-general-success-foreground" />
                ) : (
                  <ArrowUpToLine className="h-5 w-5 text-general-destructive-foreground" />
                )}
              </div>
              <div>
                <div className="font-semibold">{activityType}</div>
                <div className="text-md text-muted-foreground font-medium">
                  {getActivityFrom(
                    activity.amount,
                    activity.counterparty,
                    activity.receiver_id
                  )}
                </div>
              </div>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "amount",
        header: "",
        cell: ({ row }) => {
          const activity = row.original;
          const isReceived = parseFloat(activity.amount) > 0;

          return (
            <div className="text-right">
              <div
                className={
                  isReceived
                    ? "text-general-success-foreground"
                    : "text-general-destructive-foreground"
                }
              >
                <span className="font-semibold">
                {formatAmount(activity.amount, activity.token_metadata.decimals)}{" "}
                {activity.token_metadata.symbol}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                <FormattedDate date={new Date(activity.block_time)} includeTime />
              </div>
            </div>
          );
        },
      }),
    ],
    [treasuryId]
  );

  const table = useReactTable({
    data: allActivities,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id.toString(),
  });

  return (
    <>
      <Card className="gap-3">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>History of sent and received transactions</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setIsExportModalOpen(true)}>
            <Upload className="h-4 w-4" />
            Export
          </Button>
        </CardHeader>
        <CardContent className="px-2">
          {isLoading && page === 0 ? (
            <div className="space-y-4 px-4 py-2">
              {[...Array(ITEMS_PER_PAGE)].map((_, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="space-y-2">
                      <Skeleton className="h-10 w-50" />
                    </div>
                  </div>
                  <div className="text-right space-y-2">
                    <Skeleton className="h-10 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : allActivities.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No recent activity
            </div>
          ) : (
            <>
              <Table>
                <TableBody>
                  {table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      onClick={() => handleActivityClick(row.original)}
                      className="cursor-pointer"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="p-4">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {hasMore && (
                <Button
                  variant="outline"
                  className="w-full mt-4 bg-transparent hover:bg-muted/50"
                  onClick={handleToggleShowAll}
                  disabled={isFetching}
                >
                  {isFetching ? "Loading..." : "Show More"}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <TransactionDetailsModal
        activity={selectedActivity}
        treasuryId={treasuryId || ""}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />

      <ExportActivityModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
      />
    </>
  );
}

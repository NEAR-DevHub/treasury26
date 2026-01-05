"use client";

import { Fragment, useMemo, useState } from "react";
import { Proposal, ProposalStatus, Vote } from "@/lib/proposals-api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/button";
import { ChevronDown, ChevronRight, X, Check } from "lucide-react";
import { TransactionCell } from "./transaction-cell";
import { ExpandedView } from "./expanded-view";
import { ProposalTypeIcon } from "./proposal-type-icon";
import { VotingIndicator } from "./voting-indicator";
import { Policy } from "@/types/policy";
import { useFormatDate } from "@/components/formatted-date";
import { TooltipUser } from "@/components/user";
import { Checkbox } from "@/components/ui/checkbox";
import { getProposalStatus, getProposalUIKind } from "../utils/proposal-utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Pagination } from "@/components/pagination";
import { ProposalStatusPill } from "./proposal-status-pill";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { getApproversAndThreshold, getKindFromProposal } from "@/lib/config-utils";

import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getExpandedRowModel,
  createColumnHelper,
  ExpandedState,
  getPaginationRowModel,
} from "@tanstack/react-table"

const columnHelper = createColumnHelper<Proposal>();

interface ProposalsTableProps {
  proposals: Proposal[];
  policy: Policy;
  pageIndex?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
}

export function ProposalsTable({
  proposals,
  policy,
  pageIndex = 0,
  pageSize = 10,
  total = 0,
  onPageChange
}: ProposalsTableProps) {
  const [rowSelection, setRowSelection] = useState({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const { accountId, voteProposals } = useNear();
  const { selectedTreasury } = useTreasury();
  const formatDate = useFormatDate();

  const columns = useMemo<ColumnDef<Proposal, any>[]>(
    () => [
      columnHelper.display({
        id: "select",
        header: ({ table }) => {
          // Only show header checkbox if at least one row can be selected
          const hasSelectableRows = table.getRowModel().rows.some(row => row.getCanSelect());

          if (!hasSelectableRows) {
            return null;
          }

          return (
            <Checkbox
              checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
              onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
              aria-label="Select all"
            />
          );
        },
        cell: ({ row }) => {
          const proposal = row.original;
          const proposalKind = getKindFromProposal(proposal.kind) ?? "call";
          const { approverAccounts } = getApproversAndThreshold(policy, accountId ?? "", proposalKind, false);
          const proposalStatus = getProposalStatus(proposal, policy);
          const canVote = approverAccounts.includes(accountId ?? "") && accountId && selectedTreasury && proposal.status === "InProgress" && proposalStatus !== "Expired";

          if (!canVote) {
            return null;
          }

          return (
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(value) => row.toggleSelected(!!value)}
              aria-label="Select row"
            />
          );
        },
        enableSorting: false,
        enableHiding: false,
      }),
      columnHelper.accessor("id", {
        header: () => <span className="text-xs font-medium uppercase text-muted-foreground">Request</span>,
        cell: (info) => {
          const proposal = info.row.original;
          const title = getProposalUIKind(proposal);
          const date = formatDate(
            new Date(parseInt(proposal.submission_time) / 1000000)
          );
          return (
            <div className="flex items-center gap-5 max-w-[400px] truncate">
              <span className="text-sm text-muted-foreground w-6 shrink-0">
                #{proposal.id}
              </span>
              <ProposalTypeIcon proposal={proposal} />
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{title}</span>
                </div>
                <span className="text-xs text-muted-foreground">{date}</span>
              </div>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "transaction",
        header: () => <span className="text-xs font-medium uppercase text-muted-foreground">Transaction</span>,
        cell: ({ row }) => (
          <div className="max-w-[300px] truncate">
            <TransactionCell proposal={row.original} />
          </div>
        ),
      }),
      columnHelper.accessor("proposer", {
        header: () => <span className="text-xs font-medium uppercase text-muted-foreground">Requester</span>,
        cell: (info) => {
          const value = info.getValue();
          return (
            <TooltipUser accountId={value}>
              <span className="text-sm">{value}</span>
            </TooltipUser>
          )
        }
      }),
      columnHelper.display({
        id: "voting",
        header: () => <span className="text-xs font-medium uppercase text-muted-foreground">Voting</span>,
        cell: ({ row }) => (
          <VotingIndicator proposal={row.original} policy={policy} />
        ),
      }),
      columnHelper.accessor("status", {
        header: () => <span className="text-xs font-medium uppercase text-muted-foreground">Status</span>,
        cell: (info) => (
          <ProposalStatusPill status={getProposalStatus(info.row.original, policy)} />
        ),
      }),
      columnHelper.display({
        id: "expand",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => row.toggleExpanded()}
            className="h-8 w-8 p-0"
          >
            {row.getIsExpanded() ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        ),
      }),
    ],
    [policy, accountId, selectedTreasury, formatDate]
  );

  const table = useReactTable({
    data: proposals,
    columns,
    state: {
      rowSelection,
      expanded,
      pagination: {
        pageIndex,
        pageSize,
      },
    },
    getPaginationRowModel: getPaginationRowModel(),
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowId: (row) => row.id.toString(),
    manualPagination: true,
    enableRowSelection: (row) => {
      const proposal = row.original;
      const proposalKind = getKindFromProposal(proposal.kind) ?? "call";
      const { approverAccounts } = getApproversAndThreshold(policy, accountId ?? "", proposalKind, false);
      const proposalStatus = getProposalStatus(proposal, policy);
      return approverAccounts.includes(accountId ?? "") && !!accountId && !!selectedTreasury && proposal.status === "InProgress" && proposalStatus !== "Expired";
    },
  });

  if (proposals.length === 0 && pageIndex === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">No proposals found.</p>
      </div>
    );
  }

  const totalPages = Math.ceil(total / pageSize);
  const selectedCount = table.getFilteredSelectedRowModel().rows.length;
  const selectedProposals = table.getFilteredSelectedRowModel().rows.map(row => row.original);

  const handleBulkVote = async (vote: "Approve" | "Reject") => {
    if (!selectedTreasury || !accountId) return;

    // All selected proposals are guaranteed to be votable due to enableRowSelection
    await voteProposals(selectedTreasury, selectedProposals.map(proposal => ({
      proposalId: proposal.id,
      vote: vote,
      proposalKind: getKindFromProposal(proposal.kind) ?? "call",
    })));

    // Clear selection after voting
    table.resetRowSelection();
  };

  return (
    <div className="flex flex-col gap-4">
      {selectedCount > 0 && (
        <div className="flex items-center justify-between pt-6 pb-4 px-5 border-b">
          <span className="font-semibold">
            {selectedCount} {selectedCount === 1 ? 'request' : 'requests'} selected
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => handleBulkVote("Reject")}
            >
              <X className="h-4 w-4" />
              Reject
            </Button>
            <Button
              variant="default"
              onClick={() => handleBulkVote("Approve")}
            >
              <Check className="h-4 w-4" />
              Approve
            </Button>
          </div>
        </div>
      )}
      <ScrollArea className="grid">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
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
                  data-state={row.getIsSelected() && "selected"}
                  onClick={(e) => {
                    // Don't expand if clicking on checkbox or expand button
                    const target = e.target as HTMLElement;
                    if (
                      target.closest('button') ||
                      target.closest('[role="checkbox"]') ||
                      target.tagName === 'INPUT'
                    ) {
                      return;
                    }
                    row.toggleExpanded();
                  }}
                  className="cursor-pointer"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
                {row.getIsExpanded() && (
                  <TableRow>
                    <TableCell colSpan={row.getVisibleCells().length} className="p-4 bg-background">
                      <ExpandedView proposal={row.original} policy={policy} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {onPageChange && (
        <Pagination
          pageIndex={pageIndex}
          totalPages={totalPages}
          onPageChange={onPageChange}
        />
      )}
    </div>
  );
}

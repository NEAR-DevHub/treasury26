"use client";

import { Fragment, useState } from "react";
import { Proposal, ProposalStatus } from "@/lib/proposals-api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";
import { TransactionCell } from "./transaction-cell";
import { ExpandedView } from "./expanded-view";
import { ProposalTypeIcon } from "./proposal-type-icon";
import { VotingIndicator } from "./voting-indicator";
import { Policy } from "@/types/policy";
import { formatDate } from "@/lib/utils";
import { User } from "@/components/user";
import { Checkbox } from "@/components/ui/checkbox";
import { getProposalStatus, getProposalUIKind } from "../utils/proposal-utils";

interface ProposalsTableProps {
  proposals: Proposal[];
  policy: Policy;
}

function getStatusColor(status: ProposalStatus): string {
  switch (status) {
    case "Approved":
      return "bg-green-500/10 text-green-600";
    case "Rejected":
    case "Failed":
      return "bg-red-500/10 text-red-600";
    case "InProgress":
      return "bg-orange-500/10 text-orange-600";
    case "Expired":
      return "bg-gray-500/10 text-gray-600";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function ProposalsTable({ proposals, policy }: ProposalsTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  const toggleRow = (id: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelect = (id: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedRows.size === proposals.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(proposals.map((p) => p.id)));
    }
  };

  if (proposals.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">No proposals found.</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>
            <Checkbox
              checked={selectedRows.size === proposals.length}
              onCheckedChange={toggleSelectAll}
            />
          </TableHead>
          <TableHead className="w-fit text-xs font-medium uppercase text-muted-foreground">
            Request
          </TableHead>
          <TableHead className="max-w-[400px] text-xs font-medium uppercase text-muted-foreground">
            Transaction
          </TableHead>
          <TableHead className="text-xs font-medium uppercase text-muted-foreground">
            Requester
          </TableHead>
          <TableHead className="text-xs font-medium uppercase text-muted-foreground">
            Voting
          </TableHead>
          <TableHead className="w-[120px] text-xs font-medium uppercase text-muted-foreground">
            Status
          </TableHead>
          <TableHead className="w-[40px]"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {proposals.map((proposal) => {
          const isExpanded = expandedRows.has(proposal.id);
          const isSelected = selectedRows.has(proposal.id);
          const title = getProposalUIKind(proposal);
          const date = formatDate(new Date(parseInt(proposal.submission_time) / 1000000));

          return (
            <Fragment key={proposal.id}>
              <TableRow>
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelect(proposal.id)}
                  />
                </TableCell>

                <TableCell className="flex items-center gap-5 max-w-[400px] truncate">
                  <span className="text-sm text-muted-foreground w-6 shrink-0">#{proposal.id}</span>
                  <ProposalTypeIcon proposal={proposal} />
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{title}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{date}</span>
                  </div>
                </TableCell>

                <TableCell className="max-w-[200px] truncate">
                  <TransactionCell proposal={proposal} />
                </TableCell>

                <TableCell>
                  <User accountId={proposal.proposer} />
                </TableCell>

                <TableCell>
                  <VotingIndicator proposal={proposal} policy={policy} />
                </TableCell>

                <TableCell>
                  <span
                    className={`inline-flex px-2 py-1 rounded-md text-xs font-medium ${getStatusColor(
                      proposal.status
                    )}`}
                  >
                    {getProposalStatus(proposal, policy)}
                  </span>
                </TableCell>

                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleRow(proposal.id)}
                    className="h-8 w-8 p-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </TableCell>
              </TableRow>

              {isExpanded && (
                <TableRow>
                  <TableCell colSpan={7} className="p-4 bg-background">
                    <ExpandedView proposal={proposal} policy={policy} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/button";
import { ChevronRight, Check, X } from "lucide-react";
import Link from "next/link";
import { useTreasury } from "@/stores/treasury-store";
import { useProposals } from "@/hooks/use-proposals";
import { Skeleton } from "@/components/ui/skeleton";
import { ProposalTypeIcon } from "./proposal-type-icon";
import { TransactionCell } from "./transaction-cell";
import { NumberBadge } from "@/components/number-badge";
import { getProposalUIKind } from "../utils/proposal-utils";
import { FormattedDate } from "@/components/formatted-date";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useNear } from "@/stores/near-store";
import {
  getApproversAndThreshold,
  getKindFromProposal,
} from "@/lib/config-utils";
import type { Proposal } from "@/lib/proposals-api";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function PendingRequests() {
  const { selectedTreasury } = useTreasury();
  const { accountId, voteProposals } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const [votingProposalId, setVotingProposalId] = useState<number | null>(null);

  const { data, isLoading } = useProposals(selectedTreasury, {
    page: 0,
    statuses: ["InProgress"],
    sort_by: "CreationTime",
    sort_direction: "desc",
  });

  const proposals = data?.proposals || [];
  const total = data?.total || 0;

  const handleVote = async (proposal: Proposal, vote: "Approve" | "Reject") => {
    if (!selectedTreasury) return;

    setVotingProposalId(proposal.id);

    try {
      await voteProposals(selectedTreasury, [
        {
          proposalId: proposal.id,
          vote: vote,
          proposalKind: proposal.kind as any,
        },
      ]);
    } finally {
      setVotingProposalId(null);
    }
  };

  const canUserVote = (proposal: Proposal): boolean => {
    if (!policy || !accountId) return false;

    const proposalKind = getKindFromProposal(proposal.kind) ?? "call";
    const { approverAccounts } = getApproversAndThreshold(
      policy,
      accountId,
      proposalKind,
      false
    );
    return approverAccounts.includes(accountId);
  };

  const hasUserVoted = (proposal: Proposal): boolean => {
    if (!accountId) return false;
    return accountId in proposal.votes;
  };

  return (
    <Card
      className={cn(
        "bg-general-tertiary gap-3 p-3",
        isLoading || (total === 0 && "bg-white")
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-3">
        <div className="flex items-center gap-2">
          <CardTitle>Pending Requests</CardTitle>
          {total > 0 && (
            <NumberBadge number={total} className="p-3.5 rounded-full" />
          )}
        </div>
        <Link href={`/${selectedTreasury}/requests?tab=pending`}>
          <Button variant="ghost" className="gap-1">
            View all
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardHeader>
      <CardContent className="px-3">
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-20 w-full rounded-lg shrink-0" />
              </div>
            ))}
          </div>
        ) : total === 0 ? (
          <div className="text-center py-4 text-sm ">
            <h2 className="text-xl font-bold">All caught up!</h2>
            <p className="text-sm text-muted-foreground">
              There are no pending requests.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {proposals.map((proposal) => {
              const proposalType = getProposalUIKind(proposal);
              const hideSubtitle =
                proposalType === "Change Policy" ||
                proposalType === "Update General Settings";
              const canVote = canUserVote(proposal);
              const hasVoted = hasUserVoted(proposal);

              return (
                <Card
                  key={proposal.id}
                  className="p-0 group overflow-hidden transition-all"
                >
                  <Link
                    href={`/${selectedTreasury}/requests/${proposal.id}`}
                    className="flex gap-3 p-4"
                  >
                    <div className="shrink-0 mt-0.5">
                      <ProposalTypeIcon proposal={proposal} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold mb-1">{proposalType}</div>
                      {hideSubtitle ? (
                        <div className="text-xs text-muted-foreground">
                          <FormattedDate
                            date={
                              new Date(
                                Number(proposal.submission_time) / 1_000_000
                              )
                            }
                            includeTime
                          />
                        </div>
                      ) : (
                        <TransactionCell
                          proposal={proposal}
                          withDate
                          textOnly
                        />
                      )}
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                  </Link>

                  {/* Voting Buttons - Expand on hover */}
                  {canVote && (
                    <div className="max-h-0 group-hover:max-h-20 transition-all duration-300 overflow-hidden mt-[-20px]">
                      <div className="px-4 pb-4 flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1"
                          disabled={hasVoted}
                          loading={votingProposalId === proposal.id}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleVote(proposal, "Reject");
                          }}
                        >
                          <X className="h-4 w-4" />
                          Reject
                        </Button>
                        <Button
                          className="flex-1"
                          disabled={hasVoted}
                          loading={votingProposalId === proposal.id}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleVote(proposal, "Approve");
                          }}
                        >
                          <Check className="h-4 w-4" />
                          Approve
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

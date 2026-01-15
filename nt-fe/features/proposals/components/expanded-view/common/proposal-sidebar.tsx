import { Proposal, ProposalStatus, } from "@/lib/proposals-api";
import { Button } from "@/components/button";
import { ArrowUpRight, Check, X } from "lucide-react";
import { PageCard } from "@/components/card";
import { Policy } from "@/types/policy";
import { getApproversAndThreshold, getKindFromProposal } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { getProposalStatus, UIProposalStatus } from "@/features/proposals/utils/proposal-utils";
import { UserVote } from "../../user-vote";
import { useProposalTransaction } from "@/hooks/use-proposals";
import { formatDate } from "@/lib/utils";
import Link from "next/link";
import Big from "big.js";
import { User } from "@/components/user";

interface ProposalSidebarProps {
  proposal: Proposal;
  policy: Policy;
  onVote: (vote: "Approve" | "Reject" | "Remove") => void;
}

function StepIcon({ status }: { status: "Success" | "Pending" | "Failed" | "Expired" }) {
  switch (status) {
    case "Success":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-general-success-foreground">
          <Check className="h-4 w-4 text-white" />
        </div>
      );
    case "Pending":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-muted-foreground/20 bg-card" />
      );
    case "Expired":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary">
          <X className="h-4 w-4 text-muted-foreground" />
        </div>
      );
    case "Failed":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-general-destructive-foreground">
          <X className="h-4 w-4 text-white" />
        </div>
      );
  }
}

function TransactionCreated({ proposer, date }: { proposer: string, date: Date }) {
  return (
    <div className="flex flex-col gap-3 relative z-10">
      <div className="flex items-center gap-2">
        <StepIcon status="Success" />
        <div className="flex flex-col gap-0">
          <p className="text-sm font-semibold">Transaction created</p>
          {date && <p className="text-xs text-muted-foreground">{formatDate(date)}</p>}
        </div>
      </div>
      <div className="ml-5">
        <User accountId={proposer} withName={true} />
      </div>
    </div>
  );
}

function VotingSection({ proposal, policy, accountId }: { proposal: Proposal, policy: Policy, accountId: string }) {
  const votes = proposal.votes;

  const totalApprovesReceived = Object.values(votes).filter((vote) => vote === "Approve").length;
  const { requiredVotes } = getApproversAndThreshold(policy, accountId ?? "", proposal.kind, false);
  const votesArray = Object.entries(votes);

  let proposalStatus = getProposalStatus(proposal, policy);
  let statusIconStatus: "Pending" | "Failed" | "Success" = "Pending";
  if (proposalStatus === "Executed") {
    statusIconStatus = "Success";
  }

  return (
    <div className="flex flex-col gap-3 relative z-10">
      <div className="flex items-center gap-2">
        <StepIcon status={statusIconStatus} />
        <div>
          <p className="text-sm font-semibold">Voting</p>
          <p className="text-xs text-muted-foreground">
            {totalApprovesReceived}/{requiredVotes} approvals received
          </p>
        </div>
      </div>

      <div className="ml-5">
        {votesArray.map(([account, vote]) => {
          return (
            <div key={account} className="flex items-center gap-2">
              <UserVote accountId={account} vote={vote} iconOnly={false} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExecutedSection({ status, date, expiresAt }: { status: UIProposalStatus, date?: Date, expiresAt: Date }) {

  let statusIcon = <StepIcon status="Pending" />;
  let statusText = status as string;

  switch (status) {
    case "Pending":
      statusText = "Expires at";
      break;
    case "Rejected":
    case "Removed":
      statusIcon = <StepIcon status="Failed" />;
      break;
    case "Expired":
      statusIcon = <StepIcon status="Expired" />;
      break;
    case "Executed":
      statusIcon = <StepIcon status="Success" />;
      break;
  }

  return (
    <div className="space-y-3 relative z-10">
      <div className="flex items-center gap-2">
        {statusIcon}
        <div className="flex flex-col gap-0">
          <p className="text-sm font-semibold">{statusText}</p>
          <p className="text-xs text-muted-foreground">
            {formatDate(date ?? expiresAt)}
          </p>
        </div>
      </div>
    </div>
  );
}

export function ProposalSidebar({ proposal, policy, onVote }: ProposalSidebarProps) {
  const { accountId } = useNear();
  const { selectedTreasury } = useTreasury();
  const isPending = proposal.status === "InProgress";
  const proposalKind = getKindFromProposal(proposal.kind) ?? "call";
  const { approverAccounts } = getApproversAndThreshold(policy, accountId ?? "", proposalKind, false);
  const { data: transaction } = useProposalTransaction(selectedTreasury, proposal, policy);

  const status = getProposalStatus(proposal, policy);

  const canVote = approverAccounts.includes(accountId ?? "") && accountId && selectedTreasury && status === "Pending";
  const expiresAt = new Date(Big(proposal.submission_time).add(policy.proposal_period).div(1000000).toNumber());
  let timestamp;
  switch (status) {
    case "Expired":
    case "Pending":
      timestamp = expiresAt;
      break;

    default: timestamp = transaction?.timestamp
      ? new Date(transaction.timestamp / 1000000)
      : undefined;
      break;
  }

  return (
    <PageCard className="w-full">
      <div className="relative flex flex-col gap-4">
        <TransactionCreated proposer={proposal.proposer} date={new Date(Big(proposal.submission_time).div(1000000).toNumber())} />
        <VotingSection proposal={proposal} policy={policy} accountId={accountId ?? ""} />
        <ExecutedSection status={status} date={timestamp} expiresAt={expiresAt} />
        <div className="absolute left-[11px] top-1 bottom-2 w-px bg-muted-foreground/20" />
      </div>

      {transaction && (
        <Link href={transaction.nearblocks_url} target="_blank" rel="noopener noreferrer" className="flex font-medium text-sm items-center gap-1.5">
          View Transaction <ArrowUpRight className="size-4" />
        </Link>
      )}

      {/* Action Buttons */}
      {isPending && canVote && (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => onVote("Reject")}
          >
            <X className="h-4 w-4 mr-2" />
            Reject
          </Button>
          <Button
            className="flex-1"
            onClick={() => onVote("Approve")}
          >
            <Check className="h-4 w-4 mr-2" />
            Approve
          </Button>
        </div>
      )}
    </PageCard>
  );
}

import { Proposal, ProposalStatus, } from "@/lib/proposals-api";
import { Button } from "@/components/button";
import { Check, X } from "lucide-react";
import { PageCard } from "@/components/card";
import { Policy } from "@/types/policy";
import { getApproversAndThreshold, getKindFromProposal } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { getProposalStatus } from "@/features/proposals/utils/proposal-utils";
import { UserVote } from "../../user-vote";

interface ProposalSidebarProps {
  proposal: Proposal;
  policy: Policy;
  onVote: (vote: "Approve" | "Reject" | "Remove") => void;
}

function StepIcon({ status }: { status: "Success" | "Pending" | "Failed" }) {
  switch (status) {
    case "Success":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500">
          <Check className="h-4 w-4 text-white" />
        </div>
      );
    case "Pending":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-muted-foreground/20 bg-card" />
      );
    case "Failed":
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500">
          <X className="h-4 w-4 text-white" />
        </div>
      );
  }
}

function TransactionCreated() {
  return (
    <div className="space-y-3 relative z-10">
      <div className="flex items-center gap-2">
        <StepIcon status="Success" />
        <div>
          <p className="text-sm font-semibold">Transaction created</p>
        </div>
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
  if (proposalStatus === "Expired") {
    statusIconStatus = "Failed";
  } else if (proposalStatus === "Approved" || proposalStatus === "Executed") {
    statusIconStatus = "Success";
  }

  return (
    <div className="space-y-3 relative z-10">
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

function ExecutedSection({ status }: { status: ProposalStatus }) {
  let statusIcon = <StepIcon status="Pending" />;
  let statusText = "Executed";
  if (status === "Rejected") {
    statusIcon = <StepIcon status="Failed" />;
    statusText = "Rejected";
  }
  if (status === "Removed") {
    statusIcon = <StepIcon status="Failed" />;
    statusText = "Removed";
  }
  if (status === "Approved") {
    statusIcon = <StepIcon status="Success" />;
    statusText = "Executed";
  }

  return (
    <div className="space-y-3 relative z-10">
      <div className="flex items-center gap-2">
        {statusIcon}
        <div>
          <p className="text-sm font-semibold">{statusText}</p>
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

  const canVote = approverAccounts.includes(accountId ?? "") && accountId && selectedTreasury;

  return (
    <PageCard className="w-full">
      <div className="relative flex flex-col gap-4">
        <div className="absolute left-[11px] top-0 bottom-0 w-px bg-muted-foreground/20" />
        <TransactionCreated />
        <VotingSection proposal={proposal} policy={policy} accountId={accountId ?? ""} />
        <ExecutedSection status={proposal.status} />
      </div>

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

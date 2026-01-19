import { Button } from "@/components/button";
import { AuthButtonWithProposal, NO_VOTE_MESSAGE } from "@/components/auth-button";
import { PageCard } from "@/components/card";
import { NumberBadge } from "@/components/number-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useProposals } from "@/hooks/use-proposals";
import { Proposal } from "@/lib/proposals-api";
import { useTreasury } from "@/stores/treasury-store";
import { ChevronRight, Check, X, Download } from "lucide-react";
import Link from "next/link";
import { ProposalTypeIcon } from "../proposal-type-icon";
import { TransactionCell } from "../transaction-cell";
import { Policy } from "@/types/policy";
import { useTreasuryConfig, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { getProposalUIKind } from "../../utils/proposal-utils";
import { useProposalInsufficientBalance } from "../../hooks/use-proposal-insufficient-balance";
import { VoteModal } from "../vote-modal";
import { useState } from "react";
import { getKindFromProposal, ProposalPermissionKind } from "@/lib/config-utils";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { DepositModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal";

const MAX_DISPLAYED_REQUESTS = 4;

function PendingRequestItemSkeleton() {
    return (
        <Skeleton className="h-20 w-full rounded-lg" />
    );
}

function PendingRequestsSkeleton() {
    return (
        <div className="border bg-general-tertiary border-border rounded-lg p-5 gap-3 flex flex-col w-full h-fit min-h-[300px]">
            <div className="flex justify-between">
                <div className="flex items-center gap-1">
                    <h1 className="font-semibold text-nowrap">Pending Requests</h1>
                </div>
                <Button variant="ghost" className="flex gap-2" disabled>
                    View All
                    <ChevronRight className="size-4" />
                </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4">
                {Array.from({ length: MAX_DISPLAYED_REQUESTS }).map((_, index) => (
                    <PendingRequestItemSkeleton key={index} />
                ))}
            </div>
        </div>
    );
}

interface PendingRequestItemProps {
    proposal: Proposal;
    treasuryId: string;
    onVote: (vote: "Approve" | "Reject") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

export function PendingRequestItem({ proposal, treasuryId, onVote, onDeposit }: PendingRequestItemProps) {
    const type = getProposalUIKind(proposal);
    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(proposal, treasuryId);
    const { accountId } = useNear();
    const isUserVoter = !!proposal.votes[accountId ?? ""];

    return (
        <Link href={`/${treasuryId}/requests/${proposal.id}`}>
            <PageCard className="flex relative flex-row gap-3.5 justify-between w-full group">
                <ProposalTypeIcon proposal={proposal} />
                <div className="flex flex-col w-full gap-px">
                    <span className="leading-none font-semibold">{type}</span>
                    <TransactionCell proposal={proposal} withDate={true} textOnly />
                    <div className="gap-3 grid grid-rows-[0fr] w-full group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-in-out">
                        <div className="overflow-hidden w-full">
                            <div className="pt-4 flex gap-3 invisible w-full group-hover:visible transition-opacity duration-300 ease-in-out">
                                <AuthButtonWithProposal
                                    proposalKind={proposal.kind}
                                    variant="secondary"
                                    className="flex gap-1 flex-1"
                                    onClick={(e) => { e.preventDefault(); onVote("Reject") }}
                                    disabledTooltip={NO_VOTE_MESSAGE}
                                    disabled={isUserVoter}
                                >
                                    <X className="size-3.5" />
                                    Reject
                                </AuthButtonWithProposal>
                                {insufficientBalanceInfo.hasInsufficientBalance ? (
                                    <Button
                                        variant="default"
                                        className="flex gap-1 flex-1"
                                        onClick={(e) => { e.preventDefault(); onDeposit(insufficientBalanceInfo.tokenSymbol, insufficientBalanceInfo.tokenNetwork); }}
                                    >
                                        <Download className="size-3.5" />
                                        Deposit
                                    </Button>
                                ) : (
                                    <AuthButtonWithProposal
                                        proposalKind={proposal.kind}
                                        variant="default"
                                        className="flex gap-1 flex-1"
                                        onClick={(e) => { e.preventDefault(); onVote("Approve") }}
                                        disabled={isUserVoter}
                                        disabledTooltip={NO_VOTE_MESSAGE}
                                    >
                                        <Check className="size-3.5" />
                                        Approve
                                    </AuthButtonWithProposal>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-card group-hover:text-card-foreground transition-colors absolute right-4 top-4" />
            </PageCard>
        </Link>
    );
}

export function PendingRequests() {
    const { selectedTreasury } = useTreasury();
    const { data: policy, isLoading: isPolicyLoading } = useTreasuryPolicy(selectedTreasury);
    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
    const [{ tokenSymbol, tokenNetwork }, setDepositTokenInfo] = useState<{ tokenSymbol?: string, tokenNetwork?: string }>({});
    const [voteInfo, setVoteInfo] = useState<{ vote: "Approve" | "Reject" | "Remove"; proposalIds: { proposalId: number; kind: ProposalPermissionKind }[] }>({ vote: "Approve", proposalIds: [] });
    const { data: pendingRequests, isLoading: isRequestsLoading } = useProposals(selectedTreasury, {
        statuses: ["InProgress"],
    });

    const isLoading = isPolicyLoading || isRequestsLoading;

    if (isLoading || !policy) {
        return <PendingRequestsSkeleton />;
    }

    const hasPendingRequests = (pendingRequests?.proposals?.length ?? 0) > 0;

    return (
        <>
            <div className={cn("bg-general-tertiary rounded-lg p-5 gap-3 flex flex-col w-full h-fit", !hasPendingRequests ? "min-h-[300px]" : "min-h-[100px]")}>
                <div className="flex justify-between">
                    <div className="flex items-center gap-1">
                        <h1 className="font-semibold text-nowrap">Pending Requests</h1>
                        {hasPendingRequests && (
                            <NumberBadge number={pendingRequests?.proposals?.length ?? 0} />
                        )}
                    </div>

                    {hasPendingRequests && (
                        <Link href={`/${selectedTreasury}/requests`}>
                            <Button variant="ghost" className="flex gap-2">
                                View All
                                <ChevronRight className="size-4" />
                            </Button>
                        </Link>
                    )}
                </div>

                {hasPendingRequests ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4">
                        {pendingRequests?.proposals?.slice(0, MAX_DISPLAYED_REQUESTS).map((proposal) => (
                            <PendingRequestItem
                                key={proposal.id}
                                proposal={proposal}
                                treasuryId={selectedTreasury!}
                                onVote={(vote) => {
                                    setVoteInfo({ vote, proposalIds: [{ proposalId: proposal.id, kind: getKindFromProposal(proposal.kind) ?? "call" }] });
                                    setIsVoteModalOpen(true);
                                }}
                                onDeposit={(tokenSymbol, tokenNetwork) => {
                                    setDepositTokenInfo({ tokenSymbol, tokenNetwork });
                                    setIsDepositModalOpen(true);
                                }}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col gap-0.5 w-full h-full items-center justify-center my-auto">
                        <h1 className="font-semibold">All caught up!</h1>
                        <p className="text-xs text-muted-foreground">There are no pending requests.</p>
                    </div>
                )}
            </div>
            <VoteModal
                isOpen={isVoteModalOpen}
                onClose={() => setIsVoteModalOpen(false)}
                proposalIds={voteInfo.proposalIds}
                vote={voteInfo.vote}
            />
            <DepositModal
                isOpen={isDepositModalOpen}
                onClose={() => setIsDepositModalOpen(false)}
                prefillTokenSymbol={tokenSymbol}
                prefillNetworkId={tokenNetwork}
            />
        </>
    );
}

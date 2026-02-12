"use client";

import { use, useState } from "react";
import { PageComponentLayout } from "@/components/page-component-layout";
import { ExpandedView } from "@/features/proposals";
import { useProposal } from "@/hooks/use-proposals";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { VoteModal } from "@/features/proposals/components/vote-modal";
import { DepositModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal";
import {
    getKindFromProposal,
    ProposalPermissionKind,
} from "@/lib/config-utils";
import { ProposalKind } from "@/lib/proposals-api";
import { Skeleton } from "@/components/ui/skeleton";
import { PageCard } from "@/components/card";
import { redirect } from "next/navigation";

interface RequestPageProps {
    params: Promise<{
        id: string;
    }>;
}

function RequestPageSkeleton() {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 w-full">
            <div className="w-full flex flex-col gap-4">
                <PageCard className="w-full">
                    <Skeleton className="h-8 w-48 mb-6" />
                    <Skeleton className="h-[300px] w-full" />
                </PageCard>
            </div>
            <div className="w-full">
                <PageCard className="w-full">
                    <Skeleton className="h-[200px] w-full" />
                </PageCard>
            </div>
        </div>
    );
}

export default function RequestPage({ params }: RequestPageProps) {
    const { id } = use(params);
    const { treasuryId } = useTreasury();
    const { data: proposal, isLoading: isLoadingProposal } = useProposal(
        treasuryId,
        id,
    );
    const { data: policy, isLoading: isLoadingPolicy } = useTreasuryPolicy(
        treasuryId,
        proposal?.submission_time,
    );

    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
    const [{ tokenSymbol, tokenNetwork }, setDepositTokenInfo] = useState<{
        tokenSymbol?: string;
        tokenNetwork?: string;
    }>({});
    const [voteInfo, setVoteInfo] = useState<{
        vote: "Approve" | "Reject" | "Remove";
        proposalIds: { proposalId: number; kind: ProposalPermissionKind }[];
    }>({ vote: "Approve", proposalIds: [] });

    if (isLoadingProposal || isLoadingPolicy) {
        return (
            <PageComponentLayout
                title={`Request #${id}`}
                description="Details for Request"
                backButton={`/${treasuryId}/requests`}
            >
                <RequestPageSkeleton />
            </PageComponentLayout>
        );
    }

    if (!proposal || !policy) {
        redirect(`/${treasuryId}/requests`);
    }

    return (
        <PageComponentLayout
            title={`Request #${proposal?.id}`}
            description="Details for Request"
            backButton={`/${treasuryId}/requests`}
        >
            <ExpandedView
                proposal={proposal}
                policy={policy}
                hideOpenInNewTab
                onVote={(vote) => {
                    setVoteInfo({
                        vote,
                        proposalIds: [
                            {
                                proposalId: proposal?.id ?? 0,
                                kind:
                                    getKindFromProposal(
                                        proposal?.kind as ProposalKind,
                                    ) ?? "call",
                            },
                        ],
                    });
                    setIsVoteModalOpen(true);
                }}
                onDeposit={(tokenSymbol, tokenNetwork) => {
                    setDepositTokenInfo({ tokenSymbol, tokenNetwork });
                    setIsDepositModalOpen(true);
                }}
            />
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
        </PageComponentLayout>
    );
}

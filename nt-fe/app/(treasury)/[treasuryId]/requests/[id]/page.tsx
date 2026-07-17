"use client";

import { redirect, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { trackEvent } from "@/lib/analytics";
import { use, useEffect, useState } from "react";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { ExpandedView } from "@/features/proposals";
import { VoteModal } from "@/features/proposals/components/vote-modal";
import { useProposal } from "@/hooks/use-proposals";
import { useCachedProposalSubmissionTime } from "@/hooks/use-cached-proposal-submission-time";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import type { Proposal } from "@/lib/proposals-api";

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
    const t = useTranslations("pages.requests");
    const { id } = use(params);
    const { treasuryId, isLoading: isTreasuryLoading } = useTreasury();
    const router = useRouter();
    const cachedSubmissionTime = useCachedProposalSubmissionTime(
        treasuryId,
        id,
    );
    const { data: proposal, isLoading: isLoadingProposal } = useProposal(
        treasuryId,
        id,
    );
    const submissionTime = proposal?.submission_time ?? cachedSubmissionTime;
    const canLoadPolicy = !!submissionTime;
    const { data: policy, isLoading: isLoadingPolicy } = useTreasuryPolicy(
        canLoadPolicy ? treasuryId! : null,
        submissionTime,
    );

    useEffect(() => {
        if (proposal) {
            trackEvent("request-detail-viewed", {
                proposal_id: proposal.id,
                treasury_id: treasuryId!,
            });
        }
    }, [proposal?.id, proposal, treasuryId]);

    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [voteInfo, setVoteInfo] = useState<{
        vote: "Approve" | "Reject" | "Remove";
        proposals: Proposal[];
    }>({ vote: "Approve", proposals: [] });

    if (
        isTreasuryLoading ||
        isLoadingProposal ||
        (canLoadPolicy && isLoadingPolicy)
    ) {
        return (
            <PageComponentLayout
                title={t("detailTitle", { id })}
                description={t("detailDescription")}
                backButton={`/${treasuryId}/requests`}
            >
                <RequestPageSkeleton />
            </PageComponentLayout>
        );
    }

    if (!proposal) {
        redirect(`/${treasuryId}/requests`);
    }

    if (!policy) {
        redirect(`/${treasuryId}/requests`);
    }

    return (
        <PageComponentLayout
            title={t("detailTitle", { id: proposal?.id ?? "" })}
            description={t("detailDescription")}
            backButton={`/${treasuryId}/requests`}
        >
            <ExpandedView
                proposal={proposal}
                policy={policy}
                hideOpenInNewTab
                onVote={(vote) => {
                    setVoteInfo({
                        vote,
                        proposals: proposal ? [proposal] : [],
                    });
                    setIsVoteModalOpen(true);
                }}
                onDeposit={(tokenSymbol, tokenNetwork) => {
                    const params = new URLSearchParams();
                    if (tokenSymbol) {
                        params.set("token", tokenSymbol);
                    }
                    if (tokenNetwork) {
                        params.set("network", tokenNetwork);
                    }
                    const query = params.toString();
                    router.push(
                        `/${treasuryId}/dashboard/deposit${
                            query ? `?${query}` : ""
                        }`,
                    );
                }}
            />
            <VoteModal
                isOpen={isVoteModalOpen}
                onClose={() => setIsVoteModalOpen(false)}
                proposals={voteInfo.proposals}
                vote={voteInfo.vote}
            />
        </PageComponentLayout>
    );
}

"use client";

import { Delete01Icon } from "@hugeicons/core-free-icons";
import { redirect, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { use, useEffect, useState } from "react";
import { buildDepositDeepLink } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-transfer-url";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icon";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalWorkflow } from "@/features/proposals/components/request-details/approval-workflow";
import {
    RequestDetailsBody,
    RequestNotices,
    useRequestActions,
    useRequestDetailsTitle,
} from "@/features/proposals/components/request-details/request-details-content";
import { VoteModal } from "@/features/proposals/components/vote-modal";
import { useProposalDetails } from "@/features/proposals/hooks/use-proposal-details";
import { useCachedProposalSubmissionTime } from "@/hooks/use-cached-proposal-submission-time";
import { useProposal } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import type { Proposal } from "@/lib/proposals-api";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";

interface RequestPageProps {
    params: Promise<{
        id: string;
    }>;
}

/**
 * The design centres the request between two columns rather than letting it
 * spread: what it does on the left, how it is being decided on the right.
 * Stacked on a phone the cards are a single 20px-spaced run under the heading,
 * which the header already leaves room for — hence no top padding until `lg`.
 */
const COLUMNS_CLASS =
    "mx-auto flex w-full max-w-[880px] flex-col gap-5 lg:flex-row lg:items-start lg:gap-4 lg:pt-4";
const SIDE_COLUMN_CLASS = "w-full min-w-0 lg:w-[360px] lg:shrink-0";
/**
 * On a phone the cards line up with the back button in the header rather than
 * with the wider gutter the shell gives scrolling lists.
 */
const MAIN_CLASS = "px-3 md:px-6";
/** The 40px, 12px-radius square the design gives the header's controls. */
const HEADER_ICON_BUTTON_CLASS = "size-10 rounded-lg lg:size-9 lg:rounded-md";

function RequestPageSkeleton() {
    return (
        <div className={COLUMNS_CLASS}>
            <Skeleton className="h-[300px] w-full min-w-0 flex-1 rounded-2xl" />
            <div className={SIDE_COLUMN_CLASS}>
                <Skeleton className="h-[400px] w-full rounded-2xl" />
            </div>
        </div>
    );
}

export default function RequestPage({ params }: RequestPageProps) {
    const { id } = use(params);
    const { treasuryId, isLoading: isTreasuryLoading } = useTreasury();
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

    if (
        isTreasuryLoading ||
        isLoadingProposal ||
        (canLoadPolicy && isLoadingPolicy)
    ) {
        return (
            <PageComponentLayout
                title=""
                backButton={`/${treasuryId}/requests`}
                hideMobileShellControls
                mainClassName={MAIN_CLASS}
            >
                <RequestPageSkeleton />
            </PageComponentLayout>
        );
    }

    if (!proposal || !policy) {
        redirect(`/${treasuryId}/requests`);
    }

    // Remounting per request keeps the derived queries keyed to the one on
    // screen, the same way the sheet does.
    return (
        <RequestDetail key={proposal.id} proposal={proposal} policy={policy} />
    );
}

function RequestDetail({
    proposal,
    policy,
}: {
    proposal: Proposal;
    policy: Policy;
}) {
    const tExpanded = useTranslations("proposals.expanded");
    const { treasuryId, isConfidential } = useTreasury();
    const { accountId } = useNear();
    const router = useRouter();
    const details = useProposalDetails(proposal, policy);
    const title = useRequestDetailsTitle(proposal);

    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [voteInfo, setVoteInfo] = useState<{
        vote: "Approve" | "Reject" | "Remove";
        proposals: Proposal[];
    }>({ vote: "Approve", proposals: [] });

    const onVote = (vote: "Approve" | "Reject" | "Remove") => {
        setVoteInfo({ vote, proposals: [proposal] });
        setIsVoteModalOpen(true);
    };

    const actions = useRequestActions({
        proposal,
        policy,
        details,
        onVote,
        onDeposit: (tokenSymbol, tokenNetwork) => {
            // Confidential: no prefill — user should read source/ack steps.
            router.push(
                buildDepositDeepLink(
                    treasuryId!,
                    isConfidential
                        ? null
                        : { token: tokenSymbol, network: tokenNetwork },
                ),
            );
        },
    });

    const isOwnPendingProposal =
        proposal.proposer === accountId && details.isPending;
    const hasVoted = !!proposal.votes[accountId ?? ""];

    return (
        <PageComponentLayout
            title={title}
            backButton={`/${treasuryId}/requests`}
            hideMobileShellControls
            mainClassName={MAIN_CLASS}
            headerActions={
                <>
                    {isOwnPendingProposal && !hasVoted && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className={HEADER_ICON_BUTTON_CLASS}
                            tooltipContent={tExpanded("deleteRequest")}
                            onClick={() => onVote("Remove")}
                        >
                            <Icon icon={Delete01Icon} />
                        </Button>
                    )}
                    <CopyButton
                        variant="ghost"
                        size="icon"
                        className={HEADER_ICON_BUTTON_CLASS}
                        text={`${window.location.origin}/${treasuryId}/requests/${proposal.id}`}
                        tooltipContent={tExpanded("copyLink")}
                    />
                </>
            }
        >
            <div className={COLUMNS_CLASS}>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <RequestDetailsBody proposal={proposal} details={details} />
                    <RequestNotices proposal={proposal} details={details} />
                </div>

                <div className={SIDE_COLUMN_CLASS}>
                    <ApprovalWorkflow
                        proposal={proposal}
                        policy={policy}
                        details={details}
                        footer={actions}
                    />
                </div>
            </div>

            <VoteModal
                isOpen={isVoteModalOpen}
                onClose={() => setIsVoteModalOpen(false)}
                proposals={voteInfo.proposals}
                vote={voteInfo.vote}
            />
        </PageComponentLayout>
    );
}

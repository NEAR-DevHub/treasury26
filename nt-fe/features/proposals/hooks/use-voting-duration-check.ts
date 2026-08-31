"use client";

import { useEffect, useState } from "react";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import type { Proposal } from "@/lib/proposals-api";
import { nanosToMs } from "@/lib/utils";
import type { VotingDurationImpactModal } from "../components/voting-duration-impact-modal";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Shortening the voting duration can expire requests that are mid-vote, so the
 * approval that would enact the change has to show what it will sweep away
 * first. Only the *last* approval matters — every earlier one leaves the policy
 * untouched — so the impact list is fetched lazily and only for that vote.
 *
 * Returns the approve handler to wire to the button, plus the props for
 * `VotingDurationImpactModal` when this proposal is one that needs it.
 */
export function useVotingDurationCheck({
    proposal,
    isLastApprovingVote,
    onApprove,
}: {
    proposal: Proposal;
    /** Whether the viewer's approval would be the one that enacts the change. */
    isLastApprovingVote: () => boolean;
    onApprove: () => void;
}): {
    handleApprove: () => void;
    isChecking: boolean;
    modalProps: Omit<
        React.ComponentProps<typeof VotingDurationImpactModal>,
        "currentPolicy"
    > | null;
} {
    const { treasuryId } = useTreasury();
    const [isOpen, setIsOpen] = useState(false);
    const [isChecking, setIsChecking] = useState(false);

    const isVotingDurationChange =
        "ChangePolicyUpdateParameters" in proposal.kind;

    const { data: allProposalsData, isLoading: isLoadingProposals } =
        useProposals(
            treasuryId,
            { statuses: ["InProgress", "Expired"], page_size: 100 },
            isVotingDurationChange,
        );

    // The click may land before the impact list has loaded; when it does, the
    // modal opens as soon as the request settles.
    useEffect(() => {
        if (isChecking && !isLoadingProposals) {
            setIsChecking(false);
            setIsOpen(true);
        }
    }, [isChecking, isLoadingProposals]);

    let newDurationDays = 0;
    if (isVotingDurationChange) {
        const { parameters } = (
            proposal.kind as {
                ChangePolicyUpdateParameters: {
                    parameters?: { proposal_period?: string };
                };
            }
        ).ChangePolicyUpdateParameters;
        if (parameters?.proposal_period) {
            newDurationDays = Math.floor(
                nanosToMs(parameters.proposal_period) / DAY_MS,
            );
        }
    }

    const needsCheck =
        isVotingDurationChange && newDurationDays > 0 && isLastApprovingVote();

    const handleApprove = () => {
        if (!needsCheck) {
            onApprove();
            return;
        }
        if (isLoadingProposals) {
            setIsChecking(true);
            return;
        }
        setIsOpen(true);
    };

    const close = () => {
        setIsOpen(false);
        setIsChecking(false);
    };

    const confirm = () => {
        close();
        onApprove();
    };

    // Impact list: other requests still open for voting under the current policy.
    const activeProposals =
        allProposalsData?.proposals?.filter(
            (p: Proposal) => p.id !== proposal.id && p.status === "InProgress",
        ) ?? [];

    return {
        handleApprove,
        isChecking,
        modalProps: isVotingDurationChange
            ? {
                  isOpen,
                  onClose: close,
                  onConfirm: confirm,
                  onNoImpactedProposals: confirm,
                  newDurationDays,
                  activeProposals,
                  isLoadingProposals,
              }
            : null,
    };
}

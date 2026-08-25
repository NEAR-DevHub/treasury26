"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAssets } from "@/hooks/use-assets";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryMembers } from "@/hooks/use-treasury-members";
import { availableBalance } from "@/lib/balance";
import {
    canDeferThresholdSetup,
    getOnboardingStepStatus,
    isChangePolicyProposalKind,
    readOnboardingFlag,
    soloSelectedKey,
    thresholdSetupKey,
    writeOnboardingFlag,
} from "../onboarding-steps";
import {
    buildPaymentPendingRefetchInterval,
    clearPaymentPending,
} from "../payment-pending";

export function useOnboardingSteps() {
    const pathname = usePathname();
    const {
        isGuestTreasury,
        isLoading: isLoadingGuestTreasury,
        treasuryId,
    } = useTreasury();
    const { data, isLoading: isLoadingAssets } = useAssets(treasuryId);
    const { members, isLoading: isLoadingMembers } =
        useTreasuryMembers(treasuryId);
    const { tokens } = data || { tokens: [] };
    const { data: paymentProposals, isLoading: isLoadingPayments } =
        useProposals(treasuryId, { types: ["Payments"] }, true, {
            refetchOnMount: "always",
            refetchInterval: buildPaymentPendingRefetchInterval(treasuryId),
        });
    // Exclude backend sponsor ChangePolicy (confidential setup) server-side so
    // any remaining policy proposal — including from a fellow council member —
    // can complete the threshold onboarding step.
    const { data: policyProposals, isLoading: isLoadingPolicy } = useProposals(
        treasuryId,
        {
            proposal_types: ["ChangePolicy", "ChangePolicyUpdateParameters"],
            exclude_setup_proposer: true,
        },
    );
    const [soloSelected, setSoloSelected] = useState(false);
    const [thresholdSetup, setThresholdSetup] = useState(false);

    useEffect(() => {
        if (treasuryId && (paymentProposals?.proposals?.length ?? 0) > 0) {
            clearPaymentPending(treasuryId);
        }
    }, [paymentProposals, treasuryId]);

    // `pathname` is intentional: the sidebar stays mounted across routes, so we
    // re-read flags after marking solo or submitting a voting-policy change.
    useEffect(() => {
        if (!treasuryId) {
            setSoloSelected(false);
            setThresholdSetup(false);
            return;
        }
        setSoloSelected(readOnboardingFlag(soloSelectedKey(treasuryId)));
        setThresholdSetup(readOnboardingFlag(thresholdSetupKey(treasuryId)));
        void pathname;
    }, [treasuryId, pathname]);

    const markSolo = useCallback(() => {
        if (!treasuryId) return;
        writeOnboardingFlag(soloSelectedKey(treasuryId));
        writeOnboardingFlag(thresholdSetupKey(treasuryId));
        setSoloSelected(true);
        setThresholdSetup(true);
    }, [treasuryId]);

    const markThresholdLater = useCallback(() => {
        if (!treasuryId) return;
        writeOnboardingFlag(thresholdSetupKey(treasuryId));
        setThresholdSetup(true);
    }, [treasuryId]);

    const isLoading =
        isLoadingAssets ||
        isLoadingPayments ||
        isLoadingPolicy ||
        isLoadingGuestTreasury ||
        isLoadingMembers;

    const hasAssets =
        tokens.filter((token) => availableBalance(token.balance).gt(0)).length >
        0;
    const addedMember = members.length > 1;
    const hasTeam = addedMember || soloSelected;
    const hasPayment = (paymentProposals?.proposals?.length ?? 0) > 0;
    const hasThresholdProposal =
        policyProposals?.proposals?.some((proposal) =>
            isChangePolicyProposalKind(proposal.kind),
        ) ?? false;
    const hasThreshold = soloSelected || thresholdSetup || hasThresholdProposal;
    const canDeferThreshold = canDeferThresholdSetup({
        addedMember,
        thresholdComplete: hasThreshold,
    });

    const status = getOnboardingStepStatus({
        hasTeam,
        hasThreshold,
        hasAssets,
        hasPayment,
    });

    return {
        treasuryId,
        isGuestTreasury,
        isLoading,
        hasTeam,
        hasThreshold,
        hasAssets,
        hasPayment,
        canDeferThreshold,
        status,
        markSolo,
        markThresholdLater,
    };
}

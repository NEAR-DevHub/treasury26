import { useTranslations } from "next-intl";
import { PolicyChange, RoleChange, VotePolicyChange } from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";
import { Proposal } from "@/lib/proposals-api";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { extractChangePolicyData } from "../../utils/proposal-extractors";
import { computePolicyDiff } from "../../utils/policy-diff-utils";
import { useMemo } from "react";

interface ChangePolicyCellProps {
    proposal: Proposal;
    timestamp?: string;
    textOnly?: boolean;
}

function useSummary() {
    const t = useTranslations("proposals.expanded");
    return (diff: {
        policyChanges: PolicyChange[];
        roleChanges: RoleChange;
        defaultVotePolicyChanges: VotePolicyChange[];
    }): { title: string; subtitle: string } => {
        const { policyChanges, roleChanges, defaultVotePolicyChanges } = diff;

        const totalRoleChanges =
            roleChanges.addedMembers.length +
            roleChanges.removedMembers.length +
            roleChanges.updatedMembers.length;

        const uniqueRoles = new Set(
            roleChanges.roleDefinitionChanges.map((c) => c.roleName),
        );
        const uniqueRoleCount = uniqueRoles.size;

        const totalChanges =
            policyChanges.length +
            totalRoleChanges +
            uniqueRoleCount +
            defaultVotePolicyChanges.length;

        if (totalChanges === 0) {
            return {
                title: t("policyUpdate"),
                subtitle: t("noChangesDetected"),
            };
        }

        const hasRoleChanges = totalRoleChanges > 0;
        const hasRoleDefinitionChanges = uniqueRoleCount > 0;
        const hasPolicyChanges = policyChanges.length > 0;
        const hasVotePolicyChanges = defaultVotePolicyChanges.length > 0;

        const parts: string[] = [];

        if (hasRoleChanges) {
            const added = roleChanges.addedMembers.length;
            const removed = roleChanges.removedMembers.length;
            const modified = roleChanges.updatedMembers.length;

            if (added > 0) parts.push(t("membersAdded", { count: added }));
            if (removed > 0)
                parts.push(t("membersRemoved", { count: removed }));
            if (modified > 0)
                parts.push(t("membersUpdated", { count: modified }));
        }

        if (hasRoleDefinitionChanges) {
            parts.push(t("rolesModified", { count: uniqueRoleCount }));
        }

        if (hasPolicyChanges) {
            parts.push(t("parametersChanged", { count: policyChanges.length }));
        }

        if (hasVotePolicyChanges) {
            parts.push(t("defaultVotePolicyPart"));
        }

        const subtitle = parts.join(", ");

        let title = t("policyUpdate");
        if (hasRoleChanges && !hasPolicyChanges && !hasVotePolicyChanges) {
            title = t("roleChanges");
        } else if (
            hasPolicyChanges &&
            !hasRoleChanges &&
            !hasVotePolicyChanges
        ) {
            title = t("policyParameters");
        } else if (
            hasVotePolicyChanges &&
            !hasRoleChanges &&
            !hasPolicyChanges
        ) {
            title = t("defaultVotePolicy");
        } else if (hasRoleChanges && hasPolicyChanges) {
            title = t("policyRoleChanges");
        }

        return { title, subtitle };
    };
}

export function ChangePolicyCell({
    proposal,
    timestamp,
}: ChangePolicyCellProps) {
    const t = useTranslations("proposals.expanded");
    const getSummary = useSummary();
    const { treasuryId } = useTreasury();

    const isPending = proposal.status === "InProgress";

    const { data: oldPolicy, isLoading: isLoadingTimestamped } =
        useTreasuryPolicy(
            treasuryId,
            !isPending ? proposal.submission_time : null,
        );

    const summary = useMemo(() => {
        if (!oldPolicy) return null;

        const { newPolicy, originalProposalKind } =
            extractChangePolicyData(proposal);
        const diff = computePolicyDiff(
            oldPolicy,
            newPolicy,
            originalProposalKind,
        );

        return getSummary(diff);
    }, [oldPolicy, proposal, getSummary]);

    if (!isPending && isLoadingTimestamped) {
        return (
            <TitleSubtitleCell
                title={t("loadingPolicy")}
                subtitle={t("historicalData")}
                timestamp={timestamp}
            />
        );
    }

    if (!summary) {
        return (
            <TitleSubtitleCell
                title={t("policyUpdate")}
                subtitle={t("detailsUnavailable")}
                timestamp={timestamp}
            />
        );
    }

    return (
        <TitleSubtitleCell
            title={summary.title}
            subtitle={summary.subtitle}
            timestamp={timestamp}
        />
    );
}

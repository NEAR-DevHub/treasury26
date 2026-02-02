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

function getSummary(diff: {
  policyChanges: PolicyChange[];
  roleChanges: RoleChange;
  defaultVotePolicyChanges: VotePolicyChange[];
}): { title: string; subtitle: string } {
  const { policyChanges, roleChanges, defaultVotePolicyChanges } = diff;

  const totalRoleChanges =
    roleChanges.addedMembers.length +
    roleChanges.removedMembers.length +
    roleChanges.updatedMembers.length;

  // Count unique roles in roleDefinitionChanges
  const uniqueRoles = new Set(roleChanges.roleDefinitionChanges.map(c => c.roleName));
  const uniqueRoleCount = uniqueRoles.size;

  const totalChanges =
    policyChanges.length +
    totalRoleChanges +
    uniqueRoleCount +
    defaultVotePolicyChanges.length;

  if (totalChanges === 0) {
    return {
      title: "Policy Update",
      subtitle: "No changes detected",
    };
  }

  // Determine primary change type
  const hasRoleChanges = totalRoleChanges > 0;
  const hasRoleDefinitionChanges = uniqueRoleCount > 0;
  const hasPolicyChanges = policyChanges.length > 0;
  const hasVotePolicyChanges = defaultVotePolicyChanges.length > 0;

  // Build summary parts
  const parts: string[] = [];

  if (hasRoleChanges) {
    const added = roleChanges.addedMembers.length;
    const removed = roleChanges.removedMembers.length;
    const modified = roleChanges.updatedMembers.length;

    if (added > 0) parts.push(`${added} member${added !== 1 ? "s" : ""} added`);
    if (removed > 0) parts.push(`${removed} member${removed !== 1 ? "s" : ""} removed`);
    if (modified > 0) parts.push(`${modified} member${modified !== 1 ? "s" : ""} updated`);
  }

  if (hasRoleDefinitionChanges) {
    parts.push(`${uniqueRoleCount} role${uniqueRoleCount !== 1 ? "s" : ""} modified`);
  }

  if (hasPolicyChanges) {
    parts.push(`${policyChanges.length} parameter${policyChanges.length !== 1 ? "s" : ""} changed`);
  }

  if (hasVotePolicyChanges) {
    parts.push("default vote policy");
  }

  const subtitle = parts.join(", ");

  // Determine title based on primary change
  let title = "Policy Update";
  if (hasRoleChanges && !hasPolicyChanges && !hasVotePolicyChanges) {
    title = "Role Changes";
  } else if (hasPolicyChanges && !hasRoleChanges && !hasVotePolicyChanges) {
    title = "Policy Parameters";
  } else if (hasVotePolicyChanges && !hasRoleChanges && !hasPolicyChanges) {
    title = "Default Vote Policy";
  } else if (hasRoleChanges && hasPolicyChanges) {
    title = "Policy & Role Changes";
  }

  return { title, subtitle };
}

export function ChangePolicyCell({ proposal, timestamp }: ChangePolicyCellProps) {
  const { treasuryId } = useTreasury();

  const isPending = proposal.status === "InProgress";

  // If not pending, fetch the policy at the time of submission
  const { data: oldPolicy, isLoading: isLoadingTimestamped } = useTreasuryPolicy(
    treasuryId,
    !isPending ? proposal.submission_time : null
  );

  const summary = useMemo(() => {
    if (!oldPolicy) return null;

    const { newPolicy, originalProposalKind } = extractChangePolicyData(proposal);
    const diff = computePolicyDiff(oldPolicy, newPolicy, originalProposalKind);

    return getSummary(diff);
  }, [oldPolicy, proposal]);

  if (!isPending && isLoadingTimestamped) {
    return (
      <TitleSubtitleCell
        title="Loading policy..."
        subtitle="Historical data..."
        timestamp={timestamp}
      />
    );
  }

  if (!summary) {
    return (
      <TitleSubtitleCell
        title="Policy Update"
        subtitle="Details unavailable"
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

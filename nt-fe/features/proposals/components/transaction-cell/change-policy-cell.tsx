import { ChangePolicyData } from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface ChangePolicyCellProps {
  data: ChangePolicyData;
  timestamp?: string;
  textOnly?: boolean;
}

function getSummary(data: ChangePolicyData): { title: string; subtitle: string } {
  const totalRoleChanges =
    data.roleChanges.addedMembers.length +
    data.roleChanges.removedMembers.length +
    data.roleChanges.updatedMembers.length;

  // Count unique roles in roleDefinitionChanges
  const uniqueRoles = new Set(data.roleChanges.roleDefinitionChanges.map(c => c.roleName));
  const uniqueRoleCount = uniqueRoles.size;

  const totalChanges =
    data.policyChanges.length +
    totalRoleChanges +
    uniqueRoleCount +
    data.defaultVotePolicyChanges.length;

  if (totalChanges === 0) {
    return {
      title: "Policy Update",
      subtitle: "No changes detected",
    };
  }

  // Determine primary change type
  const hasRoleChanges = totalRoleChanges > 0;
  const hasRoleDefinitionChanges = uniqueRoleCount > 0;
  const hasPolicyChanges = data.policyChanges.length > 0;
  const hasVotePolicyChanges = data.defaultVotePolicyChanges.length > 0;

  // Build summary parts
  const parts: string[] = [];

  if (hasRoleChanges) {
    const added = data.roleChanges.addedMembers.length;
    const removed = data.roleChanges.removedMembers.length;
    const modified = data.roleChanges.updatedMembers.length;

    if (added > 0) parts.push(`${added} member${added !== 1 ? "s" : ""} added`);
    if (removed > 0) parts.push(`${removed} member${removed !== 1 ? "s" : ""} removed`);
    if (modified > 0) parts.push(`${modified} member${modified !== 1 ? "s" : ""} updated`);
  }

  if (hasRoleDefinitionChanges) {
    parts.push(`${uniqueRoleCount} role${uniqueRoleCount !== 1 ? "s" : ""} modified`);
  }

  if (hasPolicyChanges) {
    parts.push(`${data.policyChanges.length} parameter${data.policyChanges.length !== 1 ? "s" : ""}`);
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

export function ChangePolicyCell({ data, timestamp }: ChangePolicyCellProps) {
  const { title, subtitle } = getSummary(data);

  return (
    <TitleSubtitleCell
      title={title}
      subtitle={subtitle}
      timestamp={timestamp}
    />
  );
}

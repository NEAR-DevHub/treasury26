import { ChangePolicyData, PolicyChange, MemberRoleChange, VotePolicyChange, RoleDefinitionChange } from "../../types/index";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Amount } from "../amount";
import { formatNanosecondDuration } from "@/lib/utils";
import { User } from "@/components/user";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/pill";
import { ApprovalInfo } from "@/components/approval-info";
import { Button } from "@/components/button";
import { renderDiff, isNullValue } from "../../utils/diff-utils";

interface ChangePolicyExpandedProps {
  data: ChangePolicyData;
}

function formatFieldLabel(field: PolicyChange["field"]): string {
  const labels: Record<PolicyChange["field"], string> = {
    proposal_bond: "Proposal Bond",
    proposal_period: "Proposal Period",
    bounty_bond: "Bounty Bond",
    bounty_forgiveness_period: "Bounty Forgiveness Period",
  };
  return labels[field];
}

function formatFieldValue(field: PolicyChange["field"], value: string): React.ReactNode {
  if (isNullValue(value)) return <span className="text-muted-foreground/50">null</span>;
  const isAmountField = field === "proposal_bond" || field === "bounty_bond";
  const isDurationField = field === "proposal_period" || field === "bounty_forgiveness_period";

  if (isAmountField) {
    return <Amount amount={value} tokenId="near" />;
  }
  if (isDurationField) {
    return <span>{formatNanosecondDuration(value)}</span>;
  }
  return <span>{value}</span>;
}

function formatVotePolicyFieldLabel(field: VotePolicyChange["field"], roleName?: string): string {
  if (field === "threshold") {
    if (roleName === "Approver") return "Vote Threshold";
    if (roleName === "Admin") return "Admin Threshold";
    return "Approver Threshold";
  }
  const labels: Record<VotePolicyChange["field"], string> = {
    weight_kind: "Weight Kind",
    quorum: "Quorum",
    threshold: "Threshold",
  };
  return labels[field];
}

function formatThreshold(threshold: any): React.ReactNode {
  if (isNullValue(threshold)) return <span className="text-muted-foreground/50">null</span>;
  if (typeof threshold === "string") {
    const parsed = parseInt(threshold);
    if (!isNaN(parsed)) {
      return <span>{parsed} Votes</span>;
    }
    return <span>{threshold}</span>;
  }
  if (Array.isArray(threshold) && threshold.length === 2) {
    return <span>{threshold[0]} Votes (threshold)</span>;
  }
  return <span>{JSON.stringify(threshold)}</span>;
}

function formatVotePolicyValue(field: VotePolicyChange["field"], value: any): React.ReactNode {
  if (field === "threshold") {
    return formatThreshold(value);
  }
  return isNullValue(value) ? <span className="text-muted-foreground/50">null</span> : <span>{String(value)}</span>;
}

interface MemberChangesDisplayProps {
  changes: MemberRoleChange[];
  type: "added" | "removed" | "updated";
}

function MemberChangesDisplay({ changes, type }: MemberChangesDisplayProps) {
  const [expandedIndices, setExpandedIndices] = useState<number[]>([]);

  if (changes.length === 0) return null;

  const getCategoryLabel = () => {
    if (type === "added") return "Add New Member";
    if (type === "removed") return "Remove Member";
    return "Update Member Permissions";
  };

  const getPluralCategoryLabel = () => {
    if (type === "added") return "Add New Members";
    if (type === "removed") return "Remove Members";
    return "Update Members Permissions";
  };

  const getMemberItems = (change: MemberRoleChange): InfoItem[] => {
    const items: InfoItem[] = [
      {
        label: "Member",
        value: <User accountId={change.member} />
      }
    ];

    if (type === "added" && change.newRoles) {
      items.push({
        label: "Permissions",
        value: <div className="flex flex-wrap gap-1">
          {change.newRoles.map((role) => (
            <Pill key={role} title={role} variant="secondary" />
          ))}
        </div>
      });
    }

    if (type === "removed" && change.oldRoles) {
      items.push({
        label: "Permissions",
        value: <div className="flex flex-wrap gap-1">
          {change.oldRoles.map((role) => (
            <Pill key={role} title={role} variant="secondary" />
          ))}
        </div>
      });
    }

    if (type === "updated") {
      if (change.oldRoles) {
        items.push({
          label: "Old Permissions",
          value: <div className="flex flex-wrap gap-1">
            {change.oldRoles.map((role) => (
              <Pill key={role} title={role} variant="secondary" />
            ))}
          </div>
        });
      }
      if (change.newRoles) {
        items.push({
          label: "New Permissions",
          value: <div className="flex flex-wrap gap-1">
            {change.newRoles.map((role) => (
              <Pill key={role} title={role} variant="secondary" />
            ))}
          </div>
        });
      }
    }

    return items;
  };

  const onExpandedChanged = (index: number) => {
    setExpandedIndices((prev) => {
      if (prev.includes(index)) {
        return prev.filter((i) => i !== index);
      }
      return [...prev, index];
    });
  };

  const isAllExpanded = expandedIndices.length === changes.length;
  const toggleAllExpanded = () => {
    if (isAllExpanded) {
      setExpandedIndices([]);
    } else {
      setExpandedIndices(changes.map((_, index) => index));
    }
  };

  if (changes.length === 1) {
    // Single change - show directly with category
    return <InfoDisplay items={[
      {
        label: "Category",
        value: <span>{getCategoryLabel()}</span>
      },
      ...getMemberItems(changes[0])
    ]} />;
  }

  // Multiple changes - show with collapsible sections per member
  return (
    <InfoDisplay items={[
      {
        label: "Category",
        value: <span>{getPluralCategoryLabel()}</span>
      },
      {
        label: "Members",
        value: <div className="flex gap-3 items-baseline">
          <p className="text-sm font-medium">{changes.length} member{changes.length > 1 ? "s" : ""}</p>
          <Button variant="ghost" size="sm" onClick={toggleAllExpanded}>
            {isAllExpanded ? "Collapse all" : "Expand all"}
          </Button>
        </div>,
        afterValue: <div className="flex flex-col gap-1">
          {changes.map((change, index) => (
            <Collapsible
              key={`${change.member}-${index}`}
              open={expandedIndices.includes(index)}
              onOpenChange={() => onExpandedChanged(index)}
            >
              <CollapsibleTrigger className={cn("w-full flex justify-between items-center p-3 border rounded-lg", expandedIndices.includes(index) && "rounded-b-none")}>
                <div className="flex gap-2 items-center">
                  <ChevronDown className={cn("w-4 h-4", expandedIndices.includes(index) && "rotate-180")} />
                  {change.member}
                </div>
                <div className="flex gap-1">
                  {(type === "added" ? change.newRoles : type === "removed" ? change.oldRoles : change.newRoles)?.map((role) => (
                    <Pill key={role} title={role} variant="secondary" />
                  ))}
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <InfoDisplay style="secondary" className="p-3 rounded-b-lg" items={getMemberItems(change)} />
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      }
    ]} />
  );
}

export function ChangePolicyExpanded({ data }: ChangePolicyExpandedProps) {
  const hasNoChanges =
    data.policyChanges.length === 0 &&
    data.roleChanges.addedMembers.length === 0 &&
    data.roleChanges.removedMembers.length === 0 &&
    data.roleChanges.updatedMembers.length === 0 &&
    data.roleChanges.roleDefinitionChanges.length === 0 &&
    data.defaultVotePolicyChanges.length === 0;

  if (hasNoChanges) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        No changes detected - the proposed policy is identical to the current policy.
      </div>
    );
  }

  const items: InfoItem[] = [];

  // Add policy parameter changes
  data.policyChanges.forEach((change) => {
    const isOldNull = change.oldValue === "null" || change.oldValue === null;
    items.push({
      label: formatFieldLabel(change.field),
      value: renderDiff(
        formatFieldValue(change.field, change.oldValue ?? "null"),
        formatFieldValue(change.field, change.newValue ?? "null"),
        isOldNull
      )
    });
  });

  // Add default vote policy changes
  data.defaultVotePolicyChanges.forEach((change) => {
    const isOldNull = change.oldValue === null || change.oldValue === undefined;
    items.push({
      label: formatVotePolicyFieldLabel(change.field),
      value: renderDiff(
        formatVotePolicyValue(change.field, change.oldValue),
        formatVotePolicyValue(change.field, change.newValue),
        isOldNull
      )
    });
  });

  const mainDisplay = <InfoDisplay items={items} />;

  return (
    <div className="flex flex-col gap-4">
      {items.length > 0 && mainDisplay}

      {/* Added Members */}
      {data.roleChanges.addedMembers.length > 0 && (
        <MemberChangesDisplay
          changes={data.roleChanges.addedMembers}
          type="added"
        />
      )}

      {/* Updated Members */}
      {data.roleChanges.updatedMembers.length > 0 && (
        <MemberChangesDisplay
          changes={data.roleChanges.updatedMembers}
          type="updated"
        />
      )}

      {/* Removed Members */}
      {data.roleChanges.removedMembers.length > 0 && (
        <MemberChangesDisplay
          changes={data.roleChanges.removedMembers}
          type="removed"
        />
      )}

      {/* Role Definition Changes */}
      {(() => {
        // Group changes by role name
        const roleGroups = new Map<string, RoleDefinitionChange[]>();
        data.roleChanges.roleDefinitionChanges.forEach((change) => {
          const existing = roleGroups.get(change.roleName) || [];
          roleGroups.set(change.roleName, [...existing, change]);
        });

        return Array.from(roleGroups.entries()).map(([roleName, changes]) => {
          const firstChange = changes[0];
          const roleItems: InfoItem[] = [];
          // Add threshold changes (use first change since threshold is role-wide)
          if (firstChange.oldThreshold !== undefined && firstChange.newThreshold !== undefined &&
            JSON.stringify(firstChange.oldThreshold) !== JSON.stringify(firstChange.newThreshold)) {
            const isOldNull = firstChange.oldThreshold === null;
            roleItems.push({
              label: formatVotePolicyFieldLabel("threshold", roleName),
              value: renderDiff(
                formatVotePolicyValue("threshold", firstChange.oldThreshold),
                formatVotePolicyValue("threshold", firstChange.newThreshold),
                isOldNull
              )
            });
          }

          // Add quorum changes
          if (firstChange.oldQuorum !== firstChange.newQuorum) {
            const isOldNull = firstChange.oldQuorum === null || firstChange.oldQuorum === undefined;
            roleItems.push({
              label: "Quorum",
              value: renderDiff(
                formatVotePolicyValue("quorum", firstChange.oldQuorum),
                formatVotePolicyValue("quorum", firstChange.newQuorum),
                isOldNull
              )
            });
          }

          // Add weight kind changes
          if (firstChange.oldWeightKind !== firstChange.newWeightKind) {
            const isOldNull = firstChange.oldWeightKind === null || firstChange.oldWeightKind === undefined;
            roleItems.push({
              label: "Weight Kind",
              value: renderDiff(
                formatVotePolicyValue("weight_kind", firstChange.oldWeightKind),
                formatVotePolicyValue("weight_kind", firstChange.newWeightKind),
                isOldNull
              )
            });
          }

          // Add permissions changes
          if (firstChange.oldPermissions && firstChange.newPermissions &&
            JSON.stringify([...firstChange.oldPermissions].sort()) !== JSON.stringify([...firstChange.newPermissions].sort())) {
            const isOldNull = firstChange.oldPermissions === null;
            roleItems.push({
              label: "Permissions",
              value: renderDiff(
                <div className="flex flex-wrap gap-1">
                  {firstChange.oldPermissions?.map((permission) => (
                    <Pill key={permission} title={permission} variant="secondary" />
                  )) || <span className="text-muted-foreground/50">null</span>}
                </div>,
                <div className="flex flex-wrap gap-1">
                  {firstChange.newPermissions.map((permission) => (
                    <Pill key={permission} title={permission} variant="secondary" />
                  ))}
                </div>,
                isOldNull
              )
            });
          }

          return <InfoDisplay key={roleName} items={roleItems} />;
        });
      })()}

      {/* Transaction Details */}
      <InfoDisplay
        items={[{
          label: "Transaction Details",
          differentLine: true,
          value: <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
            <code className="text-foreground/90">
              {JSON.stringify(data.originalProposalKind, null, 2)}
            </code>
          </pre>
        }]}
      />
    </div>
  );
}

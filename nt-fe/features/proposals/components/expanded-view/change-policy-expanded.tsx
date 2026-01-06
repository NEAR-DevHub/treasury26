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
import { Button } from "@/components/button";
import { renderDiff, isNullValue } from "../../utils/diff-utils";
import { formatRoleName } from "@/components/role-name";

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
    return <Amount amount={value} showNetwork tokenId="near" />;
  }
  if (isDurationField) {
    return <span>{formatNanosecondDuration(value)}</span>;
  }
  return <span>{value}</span>;
}

function formatVotePolicyFieldLabel(field: VotePolicyChange["field"], roleName?: string): string {
  if (field === "threshold") {
    if (roleName) {
      return `${formatRoleName(roleName)} Threshold`;
    }
    return "Default Threshold";
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
    return <span>{threshold[0]} Votes</span>;
  }
  return <span>{JSON.stringify(threshold)}</span>;
}

function formatVotePolicyValue(field: VotePolicyChange["field"], value: any): React.ReactNode {
  if (field === "threshold") {
    return formatThreshold(value);
  }
  return isNullValue(value) ? <span className="text-muted-foreground/50">null</span> : <span>{String(value)}</span>;
}

function getMemberItems(change: MemberRoleChange, type: "added" | "removed" | "updated"): InfoItem[] {
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
          <Pill key={role} title={formatRoleName(role)} variant="secondary" />
        ))}
      </div>
    });
  }

  if (type === "removed" && change.oldRoles) {
    items.push({
      label: "Permissions",
      value: <div className="flex flex-wrap gap-1">
        {change.oldRoles.map((role) => (
          <Pill key={role} title={formatRoleName(role)} variant="secondary" />
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
            <Pill key={role} title={formatRoleName(role)} variant="secondary" />
          ))}
        </div>
      });
    }
    if (change.newRoles) {
      items.push({
        label: "New Permissions",
        value: <div className="flex flex-wrap gap-1">
          {change.newRoles.map((role) => (
            <Pill key={role} title={formatRoleName(role)} variant="secondary" />
          ))}
        </div>
      });
    }
  }

  return items;
}

function getCategoryLabel(type: "added" | "removed" | "updated", plural: boolean = false) {
  if (type === "added") return plural ? "Add New Members" : "Add New Member";
  if (type === "removed") return plural ? "Remove Members" : "Remove Member";
  return plural ? "Update Members Permissions" : "Update Member Permissions";
}

export function ChangePolicyExpanded({ data }: ChangePolicyExpandedProps) {
  const [expandedAdded, setExpandedAdded] = useState<number[]>([]);
  const [expandedRemoved, setExpandedRemoved] = useState<number[]>([]);
  const [expandedUpdated, setExpandedUpdated] = useState<number[]>([]);

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

  const allItems: InfoItem[] = [];

  // 1. Policy parameter changes
  data.policyChanges.forEach((change) => {
    const isOldNull = isNullValue(change.oldValue);
    allItems.push({
      label: formatFieldLabel(change.field),
      value: renderDiff(
        formatFieldValue(change.field, change.oldValue ?? "null"),
        formatFieldValue(change.field, change.newValue ?? "null"),
        isOldNull
      )
    });
  });

  // 2. Default vote policy changes
  data.defaultVotePolicyChanges.forEach((change) => {
    const isOldNull = isNullValue(change.oldValue);
    allItems.push({
      label: formatVotePolicyFieldLabel(change.field),
      value: renderDiff(
        formatVotePolicyValue(change.field, change.oldValue),
        formatVotePolicyValue(change.field, change.newValue),
        isOldNull
      )
    });
  });

  // 3. Member sections helper
  const addMemberSection = (changes: MemberRoleChange[], type: "added" | "removed" | "updated", expanded: number[], setExpanded: (val: number[] | ((prev: number[]) => number[])) => void) => {
    if (changes.length === 0) return;

    if (changes.length === 1) {
      allItems.push({
        label: "Category",
        value: <span>{getCategoryLabel(type)}</span>
      });
      allItems.push(...getMemberItems(changes[0], type));
    } else {
      const isAllExpanded = expanded.length === changes.length;
      const toggleAll = () => {
        if (isAllExpanded) setExpanded([]);
        else setExpanded(changes.map((_, i) => i));
      };

      allItems.push({
        label: "Category",
        value: <span>{getCategoryLabel(type, true)}</span>
      });

      allItems.push({
        label: "Members",
        value: <div className="flex gap-3 items-baseline">
          <p className="text-sm font-medium">{changes.length} members</p>
          <Button variant="ghost" size="sm" onClick={toggleAll}>
            {isAllExpanded ? "Collapse all" : "Expand all"}
          </Button>
        </div>,
        afterValue: <div className="flex flex-col gap-1">
          {changes.map((change, index) => (
            <Collapsible
              key={`${change.member}-${index}`}
              open={expanded.includes(index)}
              onOpenChange={() => {
                setExpanded(prev => prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]);
              }}
            >
              <CollapsibleTrigger className={cn("w-full flex justify-between items-center p-3 border rounded-lg", expanded.includes(index) && "rounded-b-none")}>
                <div className="flex gap-2 items-center">
                  <ChevronDown className={cn("w-4 h-4", expanded.includes(index) && "rotate-180")} />
                  {change.member}
                </div>
                <div className="flex gap-1">
                  {(type === "added" ? change.newRoles : type === "removed" ? change.oldRoles : change.newRoles)?.map((role) => (
                    <Pill key={role} title={formatRoleName(role)} variant="secondary" />
                  ))}
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <InfoDisplay style="secondary" className="p-3 rounded-b-lg" items={getMemberItems(change, type)} />
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      });
    }
  };

  addMemberSection(data.roleChanges.addedMembers, "added", expandedAdded, setExpandedAdded);
  addMemberSection(data.roleChanges.updatedMembers, "updated", expandedUpdated, setExpandedUpdated);
  addMemberSection(data.roleChanges.removedMembers, "removed", expandedRemoved, setExpandedRemoved);

  // 4. Role Definition Changes
  const roleGroups = new Map<string, RoleDefinitionChange[]>();
  data.roleChanges.roleDefinitionChanges.forEach((change) => {
    const existing = roleGroups.get(change.roleName) || [];
    roleGroups.set(change.roleName, [...existing, change]);
  });

  Array.from(roleGroups.entries()).forEach(([roleName, changes]) => {
    const firstChange = changes[0];

    if (firstChange.oldThreshold !== undefined && firstChange.newThreshold !== undefined &&
      JSON.stringify(firstChange.oldThreshold) !== JSON.stringify(firstChange.newThreshold)) {
      const isOldNull = isNullValue(firstChange.oldThreshold);
      allItems.push({
        label: formatVotePolicyFieldLabel("threshold", roleName),
        value: renderDiff(
          formatVotePolicyValue("threshold", firstChange.oldThreshold),
          formatVotePolicyValue("threshold", firstChange.newThreshold),
          isOldNull
        )
      });
    }

    if (firstChange.oldQuorum !== firstChange.newQuorum) {
      const isOldNull = isNullValue(firstChange.oldQuorum);
      allItems.push({
        label: "Quorum",
        value: renderDiff(
          formatVotePolicyValue("quorum", firstChange.oldQuorum),
          formatVotePolicyValue("quorum", firstChange.newQuorum),
          isOldNull
        )
      });
    }

    if (firstChange.oldWeightKind !== firstChange.newWeightKind) {
      const isOldNull = isNullValue(firstChange.oldWeightKind);
      allItems.push({
        label: "Weight Kind",
        value: renderDiff(
          formatVotePolicyValue("weight_kind", firstChange.oldWeightKind),
          formatVotePolicyValue("weight_kind", firstChange.newWeightKind),
          isOldNull
        )
      });
    }

    if (firstChange.oldPermissions && firstChange.newPermissions &&
      JSON.stringify([...firstChange.oldPermissions].sort()) !== JSON.stringify([...firstChange.newPermissions].sort())) {
      const isOldNull = isNullValue(firstChange.oldPermissions);
      allItems.push({
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
  });

  // 5. Transaction Details
  allItems.push({
    label: "Transaction Details",
    differentLine: true,
    value: <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
      <code className="text-foreground/90">
        {JSON.stringify(data.originalProposalKind, null, 2)}
      </code>
    </pre>
  });

  return <InfoDisplay items={allItems} />;
}

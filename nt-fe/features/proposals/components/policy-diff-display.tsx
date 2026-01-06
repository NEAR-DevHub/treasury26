import { PolicyChange, RoleChange, VotePolicyChange } from "../types/index";
import { Amount } from "./amount";
import { formatNanosecondDuration } from "@/lib/utils";
import { User } from "@/components/user";
import { ApprovalInfo } from "@/components/approval-info";
import { VotePolicy } from "@/types/policy";
import { ArrowRight } from "lucide-react";

interface PolicyChangeDiffProps {
  change: PolicyChange;
}

export function PolicyChangeDiff({ change }: PolicyChangeDiffProps) {
  const isAmountField = change.field === "proposal_bond" || change.field === "bounty_bond";
  const isDurationField = change.field === "proposal_period" || change.field === "bounty_forgiveness_period";

  const fieldLabels: Record<PolicyChange["field"], string> = {
    proposal_bond: "Proposal Bond",
    proposal_period: "Proposal Period",
    bounty_bond: "Bounty Bond",
    bounty_forgiveness_period: "Bounty Forgiveness Period",
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-card rounded-lg border">
      <div className="flex-1">
        <div className="text-sm font-medium text-muted-foreground mb-1">
          {fieldLabels[change.field]}
        </div>
        <div className="flex items-center gap-2">
          <div className="px-2 py-1 bg-red-500/10 text-red-600 dark:text-red-400 rounded text-sm line-through">
            {isAmountField && <Amount amount={change.oldValue} tokenId="near" />}
            {isDurationField && formatNanosecondDuration(change.oldValue)}
            {!isAmountField && !isDurationField && change.oldValue}
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <div className="px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded text-sm font-medium">
            {isAmountField && <Amount amount={change.newValue} tokenId="near" />}
            {isDurationField && formatNanosecondDuration(change.newValue)}
            {!isAmountField && !isDurationField && change.newValue}
          </div>
        </div>
      </div>
    </div>
  );
}

interface VotePolicyChangeDiffProps {
  change: VotePolicyChange;
}

function formatThreshold(threshold: any): React.ReactNode {
  if (typeof threshold === "string") {
    return <span>{threshold}</span>;
  }
  if (Array.isArray(threshold) && threshold.length === 2) {
    return <ApprovalInfo variant="pupil" requiredVotes={threshold[0]} approverAccounts={Array(threshold[1]).fill("")} />;
  }
  return <span>{JSON.stringify(threshold)}</span>;
}

export function VotePolicyChangeDiff({ change }: VotePolicyChangeDiffProps) {
  const fieldLabels: Record<VotePolicyChange["field"], string> = {
    weight_kind: "Weight Kind",
    quorum: "Quorum",
    threshold: "Threshold",
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-card rounded-lg border">
      <div className="flex-1">
        <div className="text-sm font-medium text-muted-foreground mb-1">
          {fieldLabels[change.field]}
        </div>
        <div className="flex items-center gap-2">
          <div className="px-2 py-1 bg-red-500/10 text-red-600 dark:text-red-400 rounded text-sm line-through">
            {change.field === "threshold" ? formatThreshold(change.oldValue) : String(change.oldValue)}
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <div className="px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded text-sm font-medium">
            {change.field === "threshold" ? formatThreshold(change.newValue) : String(change.newValue)}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RoleChangeDiffProps {
  change: RoleChange;
}

function VotePolicyComparison({
  proposalKind,
  oldPolicy,
  newPolicy
}: {
  proposalKind: string;
  oldPolicy: VotePolicy;
  newPolicy: VotePolicy;
}) {
  const hasChanges =
    oldPolicy.weight_kind !== newPolicy.weight_kind ||
    oldPolicy.quorum !== newPolicy.quorum ||
    JSON.stringify(oldPolicy.threshold) !== JSON.stringify(newPolicy.threshold);

  if (!hasChanges) return null;

  return (
    <div className="bg-muted/50 p-3 rounded border">
      <div className="text-xs font-semibold text-muted-foreground mb-2">{proposalKind}</div>
      <div className="flex flex-col gap-2">
        {oldPolicy.weight_kind !== newPolicy.weight_kind && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground min-w-[100px]">Weight Kind:</span>
            <span className="text-red-600 dark:text-red-400 line-through">{oldPolicy.weight_kind}</span>
            <ArrowRight className="h-3 w-3" />
            <span className="text-green-600 dark:text-green-400 font-medium">{newPolicy.weight_kind}</span>
          </div>
        )}
        {oldPolicy.quorum !== newPolicy.quorum && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground min-w-[100px]">Quorum:</span>
            <span className="text-red-600 dark:text-red-400 line-through">{oldPolicy.quorum}</span>
            <ArrowRight className="h-3 w-3" />
            <span className="text-green-600 dark:text-green-400 font-medium">{newPolicy.quorum}</span>
          </div>
        )}
        {JSON.stringify(oldPolicy.threshold) !== JSON.stringify(newPolicy.threshold) && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground min-w-[100px]">Threshold:</span>
            <span className="text-red-600 dark:text-red-400 line-through">{formatThreshold(oldPolicy.threshold)}</span>
            <ArrowRight className="h-3 w-3" />
            <span className="text-green-600 dark:text-green-400 font-medium">{formatThreshold(newPolicy.threshold)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function RoleChangeDiff({ change }: RoleChangeDiffProps) {
  if (change.type === "added") {
    return (
      <div className="p-4 bg-green-500/5 border-2 border-green-500/20 rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <div className="px-2 py-1 bg-green-500/20 text-green-700 dark:text-green-300 rounded text-xs font-semibold">
            ADDED
          </div>
          <span className="font-semibold text-lg">{change.roleName}</span>
        </div>

        {change.newRole && (
          <div className="flex flex-col gap-3">
            {change.newRole.members && change.newRole.members.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground font-medium">Members:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {change.newRole.members.map((member) => (
                    <div key={member} className="cursor-pointer">
                      <User accountId={member} iconOnly size="md" withLink={false} withHoverCard />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <span className="text-xs text-muted-foreground font-medium">Permissions:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {change.newRole.permissions.map((permission) => (
                  <span key={permission} className="px-2 py-1 bg-primary/10 text-primary rounded text-xs">
                    {permission}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <span className="text-xs text-muted-foreground font-medium">Vote Policies:</span>
              <div className="flex flex-col gap-2 mt-2">
                {Object.entries(change.newRole.vote_policy).map(([kind, policy]) => {
                  const threshold = typeof policy.threshold === "string"
                    ? policy.threshold
                    : Array.isArray(policy.threshold)
                      ? policy.threshold
                      : [0, 0];
                  const [requiredVotes, approverAccounts] = Array.isArray(threshold)
                    ? threshold
                    : [parseInt(threshold), parseInt(threshold)];

                  return (
                    <div key={kind} className="bg-card p-2 rounded border text-sm">
                      <div className="font-medium">{kind}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <ApprovalInfo
                          variant="pupil"
                          requiredVotes={requiredVotes}
                          approverAccounts={Array(approverAccounts).fill("")}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (change.type === "removed") {
    return (
      <div className="p-4 bg-red-500/5 border-2 border-red-500/20 rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <div className="px-2 py-1 bg-red-500/20 text-red-700 dark:text-red-300 rounded text-xs font-semibold">
            REMOVED
          </div>
          <span className="font-semibold text-lg line-through">{change.roleName}</span>
        </div>

        {change.oldRole && (
          <div className="flex flex-col gap-3 opacity-70">
            {change.oldRole.members && change.oldRole.members.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground font-medium">Members:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {change.oldRole.members.map((member) => (
                    <div key={member} className="cursor-pointer">
                      <User accountId={member} iconOnly size="md" withLink={false} withHoverCard />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <span className="text-xs text-muted-foreground font-medium">Permissions:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {change.oldRole.permissions.map((permission) => (
                  <span key={permission} className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs line-through">
                    {permission}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (change.type === "modified" && change.changes) {
    return (
      <div className="p-4 bg-blue-500/5 border-2 border-blue-500/20 rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <div className="px-2 py-1 bg-blue-500/20 text-blue-700 dark:text-blue-300 rounded text-xs font-semibold">
            MODIFIED
          </div>
          <span className="font-semibold text-lg">{change.roleName}</span>
        </div>

        <div className="flex flex-col gap-4">
          {change.changes.members && (change.changes.members.added.length > 0 || change.changes.members.removed.length > 0) && (
            <div>
              <span className="text-xs text-muted-foreground font-medium block mb-2">Member Changes:</span>
              <div className="flex flex-col gap-2">
                {change.changes.members.removed.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-600 dark:text-red-400 min-w-[80px]">Removed:</span>
                    <div className="flex flex-wrap gap-1">
                      {change.changes.members.removed.map((member) => (
                        <div key={member} className="cursor-pointer opacity-70">
                          <User accountId={member} iconOnly size="md" withLink={false} withHoverCard />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {change.changes.members.added.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-600 dark:text-green-400 min-w-[80px]">Added:</span>
                    <div className="flex flex-wrap gap-1">
                      {change.changes.members.added.map((member) => (
                        <div key={member} className="cursor-pointer">
                          <User accountId={member} iconOnly size="md" withLink={false} withHoverCard />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {change.changes.permissions && (change.changes.permissions.added.length > 0 || change.changes.permissions.removed.length > 0) && (
            <div>
              <span className="text-xs text-muted-foreground font-medium block mb-2">Permission Changes:</span>
              <div className="flex flex-col gap-2">
                {change.changes.permissions.removed.length > 0 && (
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-red-600 dark:text-red-400 min-w-[80px] mt-1">Removed:</span>
                    <div className="flex flex-wrap gap-1">
                      {change.changes.permissions.removed.map((permission) => (
                        <span key={permission} className="px-2 py-1 bg-red-500/10 text-red-600 dark:text-red-400 rounded text-xs line-through">
                          {permission}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {change.changes.permissions.added.length > 0 && (
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-green-600 dark:text-green-400 min-w-[80px] mt-1">Added:</span>
                    <div className="flex flex-wrap gap-1">
                      {change.changes.permissions.added.map((permission) => (
                        <span key={permission} className="px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded text-xs font-medium">
                          {permission}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {change.changes.vote_policy && (
            change.changes.vote_policy.added.length > 0 ||
            change.changes.vote_policy.removed.length > 0 ||
            change.changes.vote_policy.modified.length > 0
          ) && (
            <div>
              <span className="text-xs text-muted-foreground font-medium block mb-2">Vote Policy Changes:</span>
              <div className="flex flex-col gap-2">
                {change.changes.vote_policy.removed.length > 0 && (
                  <div>
                    <span className="text-xs text-red-600 dark:text-red-400 block mb-1">Removed Policies:</span>
                    <div className="flex flex-wrap gap-1">
                      {change.changes.vote_policy.removed.map((kind) => (
                        <span key={kind} className="px-2 py-1 bg-red-500/10 text-red-600 dark:text-red-400 rounded text-xs">
                          {kind}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {change.changes.vote_policy.added.length > 0 && (
                  <div>
                    <span className="text-xs text-green-600 dark:text-green-400 block mb-1">Added Policies:</span>
                    <div className="flex flex-wrap gap-1">
                      {change.changes.vote_policy.added.map((kind) => (
                        <span key={kind} className="px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded text-xs">
                          {kind}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {change.changes.vote_policy.modified.length > 0 && (
                  <div>
                    <span className="text-xs text-blue-600 dark:text-blue-400 block mb-2">Modified Policies:</span>
                    <div className="flex flex-col gap-2">
                      {change.changes.vote_policy.modified.map(({ proposalKind, oldPolicy, newPolicy }) => (
                        <VotePolicyComparison
                          key={proposalKind}
                          proposalKind={proposalKind}
                          oldPolicy={oldPolicy}
                          newPolicy={newPolicy}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

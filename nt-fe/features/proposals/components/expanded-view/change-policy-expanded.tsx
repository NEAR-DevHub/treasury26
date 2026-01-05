import { ChangePolicyData } from "../../types/index";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Amount } from "../amount";
import { formatNanosecondDuration } from "@/lib/utils";
import { User } from "@/components/user";
import { VotePolicy } from "@/types/policy";
import { ApprovalInfo } from "@/components/approval-info";

interface ChangePolicyExpandedProps {
  data: ChangePolicyData;
}

function getThresholdFromPolicy(policy: VotePolicy): { requiredVotes: number; approverAccounts: number } {
  if (typeof policy.threshold === "string") {
    return { requiredVotes: parseInt(policy.threshold), approverAccounts: parseInt(policy.threshold) };
  } else if (Array.isArray(policy.threshold) && policy.threshold.length === 2) {
    return { requiredVotes: policy.threshold[0], approverAccounts: policy.threshold[1] };
  }
  return { requiredVotes: 0, approverAccounts: 0 };
}

interface VotePolicyDisplayProps {
  votePolicy: VotePolicy | Record<string, VotePolicy>;
}

function VotePolicyDisplay({ votePolicy }: VotePolicyDisplayProps) {
  // Handle Record<string, VotePolicy> (multiple policies by proposal kind)
  const isRecordType = !("weight_kind" in votePolicy);

  if (isRecordType) {
    const policies = votePolicy as Record<string, VotePolicy>;
    const policyEntries = Object.entries(policies);

    return (
      <div className="flex flex-col gap-3 mt-2">
        {policyEntries.map(([kind, policy]) => {
          const { requiredVotes, approverAccounts } = getThresholdFromPolicy(policy);
          return (
            <div key={kind} className="bg-card p-3 rounded-lg border">
              <div className="text-xs font-semibold text-muted-foreground mb-2">{kind}</div>
              <div className="flex flex-col gap-1 text-sm">
                <div className="flex gap-2">
                  <span className="text-muted-foreground min-w-[100px]">Weight Kind:</span>
                  <span className="font-medium">{policy.weight_kind}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted-foreground min-w-[100px]">Quorum:</span>
                  <span className="font-medium">{policy.quorum}</span>
                </div>
                <div className="flex gap-2 items-center">
                  <span className="text-muted-foreground min-w-[100px]">Threshold:</span>
                  <ApprovalInfo variant="pupil" requiredVotes={requiredVotes} approverAccounts={Array(approverAccounts).fill("")} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Handle single VotePolicy
  const singlePolicy = votePolicy as VotePolicy;
  const { requiredVotes, approverAccounts } = getThresholdFromPolicy(singlePolicy);

  return (
    <div className="flex flex-col gap-1 text-sm mt-2">
      <div className="flex gap-2">
        <span className="text-muted-foreground min-w-[100px]">Weight Kind:</span>
        <span className="font-medium">{singlePolicy.weight_kind}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-muted-foreground min-w-[100px]">Quorum:</span>
        <span className="font-medium">{singlePolicy.quorum}</span>
      </div>
      <div className="flex gap-2 items-center">
        <span className="text-muted-foreground min-w-[100px]">Threshold:</span>
        <ApprovalInfo variant="pupil" requiredVotes={requiredVotes} approverAccounts={Array(approverAccounts).fill("")} />
      </div>
    </div>
  );
}

function FullPolicyView({ data }: { data: ChangePolicyData }) {
  const policy = data.policy!;
  const roles = policy.roles;

  const infoItems: InfoItem[] = [
    {
      label: "Proposal Bond",
      value: <Amount amount={policy.proposal_bond} tokenId="near" />,
      info: "Amount required to be locked when creating a proposal"
    },
    {
      label: "Proposal Period",
      value: <span>{formatNanosecondDuration(policy.proposal_period)}</span>,
      info: "Duration that a proposal remains active for voting"
    },
    {
      label: "Bounty Bond",
      value: policy.bounty_bond ? <Amount amount={policy.bounty_bond} tokenId="near" /> : <span>Not set</span>,
      info: "Amount required to be locked when creating a bounty"
    },
    {
      label: "Bounty Forgiveness Period",
      value: <span>{policy.bounty_forgiveness_period ? formatNanosecondDuration(policy.bounty_forgiveness_period) : "Not set"}</span>,
      info: "Grace period before bounty bond is forfeited"
    },
    {
      label: "Roles",
      value: <span>{roles.length} role{roles.length !== 1 ? "s" : ""}</span>,
      afterValue: (
        <div className="flex flex-col gap-2 mt-2">
          {roles.map((role, index) => (
            <div key={index} className="bg-card p-3 rounded-lg border flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{role.name}</span>
                {typeof role.kind === "object" && "Group" in role.kind && (
                  <span className="px-2 py-0.5 bg-muted text-muted-foreground rounded text-xs">
                    {role.kind.Group.length} member{role.kind.Group.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {typeof role.kind === "object" && "Group" in role.kind && role.kind.Group.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground">Members:</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {[...role.kind.Group].sort().map((member, idx) => (
                      <div className="cursor-pointer">
                        <User accountId={member} iconOnly size="md" withLink={false} withHoverCard />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <span className="text-xs text-muted-foreground">Permissions:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {role.permissions.map((permission, idx) => (
                    <span key={idx} className="px-2 py-1 bg-primary/10 text-primary rounded text-xs">
                      {permission}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )
    }
  ];

  return <InfoDisplay items={infoItems} />;
}

function UpdateParametersView({ data }: { data: ChangePolicyData }) {
  const params = data.parameters!;

  const infoItems: InfoItem[] = [];

  if (params.proposal_bond !== null) {
    infoItems.push({
      label: "Proposal Bond",
      value: <Amount amount={params.proposal_bond} tokenId="near" />,
      info: "Amount required to be locked when creating a proposal"
    });
  }

  if (params.proposal_period !== null) {
    infoItems.push({
      label: "Proposal Period",
      value: <span>{formatNanosecondDuration(params.proposal_period)}</span>,
      info: "Duration that a proposal remains active for voting"
    });
  }

  if (params.bounty_bond !== null) {
    infoItems.push({
      label: "Bounty Bond",
      value: <Amount amount={params.bounty_bond} tokenId="near" />,
      info: "Amount required to be locked when creating a bounty"
    });
  }

  if (params.bounty_forgiveness_period !== null) {
    infoItems.push({
      label: "Bounty Forgiveness Period",
      value: <span>{formatNanosecondDuration(params.bounty_forgiveness_period)}</span>,
      info: "Grace period before bounty bond is forfeited"
    });
  }

  return <InfoDisplay items={infoItems} />;
}

function AddOrUpdateRoleView({ data }: { data: ChangePolicyData }) {
  const role = data.role!;

  const infoItems: InfoItem[] = [
    {
      label: "Role Name",
      value: <span className="font-semibold">{role.name}</span>
    },
    {
      label: "Permissions",
      value: <span>{role.permissions.length} permission{role.permissions.length !== 1 ? "s" : ""}</span>,
      afterValue: (
        <div className="flex flex-wrap gap-1 mt-2">
          {role.permissions.map((permission, idx) => (
            <span key={idx} className="px-2 py-1 bg-primary/10 text-primary rounded text-xs">
              {permission}
            </span>
          ))}
        </div>
      )
    },
    {
      label: "Vote Policy",
      value: <span>{Object.keys(role.vote_policy).length} proposal kind{Object.keys(role.vote_policy).length !== 1 ? "s" : ""}</span>,
      afterValue: <VotePolicyDisplay votePolicy={role.vote_policy} />
    }
  ];

  return <InfoDisplay items={infoItems} />;
}

function RemoveRoleView({ data }: { data: ChangePolicyData }) {
  const infoItems: InfoItem[] = [
    {
      label: "Role Name",
      value: <span className="font-semibold">{data.roleName}</span>,
      info: "This role will be removed from the DAO policy"
    }
  ];

  return <InfoDisplay items={infoItems} />;
}

function UpdateDefaultVotePolicyView({ data }: { data: ChangePolicyData }) {
  const votePolicy = data.votePolicy!;

  const infoItems: InfoItem[] = [
    {
      label: "Default Vote Policy",
      value: <span>Updated policy configuration</span>,
      info: "This will be used as the default voting policy for all proposal types that don't have a specific policy",
      afterValue: <VotePolicyDisplay votePolicy={votePolicy as VotePolicy} />
    }
  ];

  return <InfoDisplay items={infoItems} />;
}

export function ChangePolicyExpanded({ data }: ChangePolicyExpandedProps) {
  switch (data.type) {
    case "full":
      return <FullPolicyView data={data} />;
    case "update_parameters":
      return <UpdateParametersView data={data} />;
    case "add_or_update_role":
      return <AddOrUpdateRoleView data={data} />;
    case "remove_role":
      return <RemoveRoleView data={data} />;
    case "update_default_vote_policy":
      return <UpdateDefaultVotePolicyView data={data} />;
    default:
      return <InfoDisplay items={[{ label: "Error", value: <span>Unknown policy change type</span> }]} />;
  }
}

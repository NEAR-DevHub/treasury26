import { ChangePolicyData } from "../../types/index";

interface ChangePolicyCellProps {
  data: ChangePolicyData;
}

const POLICY_CONFIG: Record<
  ChangePolicyData["type"],
  { title: string; subtitle: string }
> = {
  full: {
    title: "Full Policy Update",
    subtitle: "Complete policy replacement with new configuration",
  },
  update_parameters: {
    title: "Policy Parameters",
    subtitle: "Updated bond amounts and voting periods",
  },
  add_or_update_role: {
    title: "Role Configuration",
    subtitle: "Added or updated role permissions",
  },
  remove_role: {
    title: "Role Removal",
    subtitle: "Removed role from DAO policy",
  },
  update_default_vote_policy: {
    title: "Default Vote Policy",
    subtitle: "Updated default voting rules and thresholds",
  },
};

export function ChangePolicyCell({ data }: ChangePolicyCellProps) {
  const { type } = data;
  const config = POLICY_CONFIG[type];

  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{config.title}</span>
      <span className="text-xs text-muted-foreground">
        {config.subtitle}
      </span>
    </div>
  );
}

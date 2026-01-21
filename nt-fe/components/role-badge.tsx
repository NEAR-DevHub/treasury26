import { Tooltip } from "@/components/tooltip";
import { getRoleDescription } from "@/lib/role-utils";
import { formatRoleName } from "@/components/role-name";

interface RoleBadgeProps {
  role: string;
  variant?: "pill" | "rounded";
  showTooltip?: boolean;
}

export function RoleBadge({ role, variant = "pill", showTooltip = true }: RoleBadgeProps) {
  const description = getRoleDescription(role);
  const displayName = formatRoleName(role);

  const badge = (
    <span
      className={`px-3 py-1 bg-muted text-foreground text-sm font-medium ${variant === "pill" ? "rounded-full" : "rounded-md"
        }`}
    >
      {displayName}
    </span>
  );

  // If we have description and tooltip is enabled, wrap in tooltip
  if (showTooltip && description) {
    return (
      <Tooltip content={description}>
        {badge}
      </Tooltip>
    );
  }

  // No description or tooltip disabled, just return the badge
  return badge;
}


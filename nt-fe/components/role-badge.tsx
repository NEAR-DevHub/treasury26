import {
  Tooltip,
} from "@/components/tooltip";
import { ROLES } from "@/components/role-selector";

interface RoleBadgeProps {
  role: string;
  variant?: "pill" | "rounded";
}

export function RoleBadge({ role, variant = "pill" }: RoleBadgeProps) {
  const roleInfo = ROLES.find((r) => r.id === role.toLowerCase());

  const badge = (
    <span
      className={`px-3 py-1 bg-muted text-foreground text-sm font-medium ${variant === "pill" ? "rounded-full" : "rounded-md"
        }`}
    >
      {role}
    </span>
  );

  // If we have description, wrap in tooltip
  if (roleInfo?.description) {
    return (
      <Tooltip content={roleInfo.description}>
        {badge}
      </Tooltip>
    );
  }

  // No description, just return the badge
  return badge;
}


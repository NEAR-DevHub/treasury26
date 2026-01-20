import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getRoleDescription } from "@/lib/role-utils";

interface RoleBadgeProps {
  role: string;
  variant?: "pill" | "rounded";
  showTooltip?: boolean;
}

export function RoleBadge({ role, variant = "pill", showTooltip = true }: RoleBadgeProps) {
  const description = getRoleDescription(role);

  const badge = (
    <span
      className={`px-3 py-1 bg-muted text-foreground text-sm font-medium ${variant === "pill" ? "rounded-full" : "rounded-md"
        }`}
    >
      {role}
    </span>
  );

  // If we have description and tooltip is enabled, wrap in tooltip
  if (showTooltip && description) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{badge}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px]">
          <p className="text-sm">{description}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // No description or tooltip disabled, just return the badge
  return badge;
}


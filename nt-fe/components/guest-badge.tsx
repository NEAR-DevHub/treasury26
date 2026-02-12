import { Pill } from "./pill";

const GUEST_TOOLTIP =
    "You are a guest of this treasury. You can only view the data. Creating requests, adding members, or making any changes is not allowed because you are not a member of the team.";

interface GuestBadgeProps {
    showTooltip?: boolean;
    side?: "top" | "bottom" | "left" | "right";
    compact?: boolean;
}

export function GuestBadge({ showTooltip, side, compact }: GuestBadgeProps) {
    return (
        <Pill
            title="Guest"
            variant="info"
            info={showTooltip ? GUEST_TOOLTIP : undefined}
            side={side}
            className={compact ? "px-1 py-0.5 text-xxs" : undefined}
        />
    );
}

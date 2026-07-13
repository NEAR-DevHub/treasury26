import { useSlotBlock, type Warning } from "@/hooks/use-warnings";
import { stripMessageForTooltip } from "@/lib/warnings";

export type VoteActionSlot = "action.approve" | "action.reject";

export interface VoteActionSlotState {
    blocked: boolean;
    message: string | null;
    warning: Warning | null;
    /** True when the block comes from an app-level pause, not this vote slot. */
    isAppLevel: boolean;
    /**
     * Tooltip for buttons that already show `<SlotWarning>` nearby — only
     * needed for app-level blocks (nothing else explains the disable).
     */
    inlineTooltip?: string;
    /**
     * Tooltip for CTAs with no nearby banner (e.g. bulk approve/reject bar).
     */
    blockedTooltip?: string;
}

export interface VoteActionSlots {
    approve: VoteActionSlotState;
    reject: VoteActionSlotState;
    /** Single banner slot covering vote actions; approve takes precedence. */
    voteBannerSlot: VoteActionSlot | null;
}

/** App-level pause blocks the slot even when the slot itself has no warning. */
export function isAppLevelSlotBlock(
    slot: string,
    blocked: boolean,
    warning: Warning | null | undefined,
): boolean {
    return blocked && warning?.slot !== slot;
}

function toVoteActionSlotState(
    slot: VoteActionSlot,
    block: ReturnType<typeof useSlotBlock>,
): VoteActionSlotState {
    const isAppLevel = isAppLevelSlotBlock(slot, block.blocked, block.warning);
    const stripped = stripMessageForTooltip(block.message) || undefined;

    return {
        blocked: block.blocked,
        message: block.message,
        warning: block.warning,
        isAppLevel,
        inlineTooltip: isAppLevel ? stripped : undefined,
        blockedTooltip: block.blocked ? stripped : undefined,
    };
}

/**
 * Shared approve/reject pause state for pending cards, sidebar, and bulk bar.
 */
export function useVoteActionSlots(): VoteActionSlots {
    const approveBlock = useSlotBlock("action.approve");
    const rejectBlock = useSlotBlock("action.reject");

    const approve = toVoteActionSlotState("action.approve", approveBlock);
    const reject = toVoteActionSlotState("action.reject", rejectBlock);

    const voteBannerSlot: VoteActionSlot | null = approve.blocked
        ? "action.approve"
        : reject.blocked
          ? "action.reject"
          : null;

    return { approve, reject, voteBannerSlot };
}

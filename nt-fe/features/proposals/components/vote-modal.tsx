import { Icon } from "@/components/icon";
import { LoaderCircleIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/button";
import { InfoAlert } from "@/components/info-alert";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Tooltip } from "@/components/tooltip";
import { SlotWarning } from "@/components/warning-message";
import { useTreasury } from "@/hooks/use-treasury";
import { useProposalApproveBlock, useSlotBlock } from "@/hooks/use-warnings";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { stripMessageForTooltip } from "@/lib/warnings";
import { isAppLevelSlotBlock } from "@/features/proposals/hooks/use-vote-action-slots";
import { useNear } from "@/stores/near-store";

interface VoteModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess?: () => void;
    proposals: Proposal[];
    vote: "Approve" | "Reject" | "Remove";
    insufficientBalanceProposalIds?: number[];
}

export function VoteModal({
    isOpen,
    onClose,
    onSuccess,
    proposals,
    vote,
    insufficientBalanceProposalIds,
}: VoteModalProps) {
    const t = useTranslations("proposals.voteModal");
    const tCreate = useTranslations("createRequestButton");
    const { treasuryId } = useTreasury();
    const { voteProposals } = useNear();
    // Each vote action has its own slot, so ops can pause approving without
    // touching reject/remove (and vice-versa). Approve → action.approve, etc.
    const voteSlot = `action.${vote.toLowerCase()}`;
    const {
        blocked: voteSlotBlocked,
        message: voteSlotMessage,
        warning: voteWarning,
    } = useSlotBlock(voteSlot);
    // The slot warning is already shown inline via <SlotWarning>, so the button
    // tooltip is only the fallback for an app-wide block (nothing visible in the
    // modal explains why the button is disabled).
    const voteBlockIsAppLevel = isAppLevelSlotBlock(
        voteSlot,
        voteSlotBlocked,
        voteWarning,
    );
    const approveBlock = useProposalApproveBlock(proposals);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Approving a payment/exchange proposal is blocked when that feature has a
    // critical warning. Rejection (and removal) is never blocked.
    const isApprove = vote === "Approve";
    const approveBlocked = isApprove && approveBlock.anyBlocked;
    const blockedWarnings = approveBlock.blockedWarnings.filter(
        (warning) => warning.slot,
    );

    const handleVote = async () => {
        setIsSubmitting(true);
        const insufficientSet = new Set(insufficientBalanceProposalIds ?? []);
        const votableProposals = proposals.filter(
            (p) => !insufficientSet.has(p.id),
        );
        try {
            await voteProposals(
                treasuryId ?? "",
                votableProposals.map((proposal) => ({
                    proposalId: proposal.id,
                    vote: vote,
                    proposal: proposal,
                })),
            );
            onSuccess?.();
        } catch (error) {
            console.error(`Failed to ${vote.toLowerCase()} proposal:`, error);
        } finally {
            setIsSubmitting(false);
            onClose();
        }
    };

    const title = vote === "Remove" ? t("removeTitle") : t("confirmTitle");
    const action =
        vote === "Approve"
            ? t("actionApprove")
            : vote === "Reject"
              ? t("actionReject")
              : t("actionRemove");
    const isBulk = proposals.length > 1;
    const hasInsufficientBalance =
        vote === "Approve" &&
        insufficientBalanceProposalIds &&
        insufficientBalanceProposalIds.length > 0;

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent
                className={cn(
                    "gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-[448px]!",
                    // On a phone the design floats the confirmation above the
                    // bottom edge rather than letting it run into it, so it
                    // keeps all four corners and its own gaps.
                    "max-sm:inset-x-2 max-sm:bottom-2 max-sm:w-auto max-sm:gap-4 max-sm:rounded-3xl",
                )}
            >
                {/* The design leaves the title bar to the close button alone
                    and centres the heading underneath it. */}
                <DialogHeader className="mx-0 border-0 px-0 pb-0" />
                <div className="flex flex-col items-center gap-1 text-center">
                    <DialogTitle className="text-xl font-bold leading-[1.2] tracking-[-0.4px]">
                        {title}
                    </DialogTitle>
                    <DialogDescription className="text-sm font-medium text-general-secondary-foreground">
                        {isBulk
                            ? t("bulkBody", { action })
                            : t("singleBody", { action })}
                    </DialogDescription>
                </div>
                <SlotWarning slot={voteSlot} />
                {approveBlocked && (
                    <div className="flex flex-col gap-2">
                        {isBulk && (
                            <InfoAlert
                                message={t("approveBlockedBulk", {
                                    count: approveBlock.blockedCount,
                                })}
                            />
                        )}
                        {blockedWarnings.map((warning) => (
                            <SlotWarning
                                key={warning.id}
                                slot={warning.slot!}
                                token={warning.token ?? undefined}
                                network={warning.network ?? undefined}
                            />
                        ))}
                    </div>
                )}
                {hasInsufficientBalance && (
                    <InfoAlert
                        message={
                            <span>
                                {t.rich("insufficientBalance", {
                                    ids: insufficientBalanceProposalIds!
                                        .map((id) => `#${id}`)
                                        .join(", "),
                                    highlight: (chunks) => (
                                        <span className="font-medium">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </span>
                        }
                    />
                )}
                <DialogFooter className="mx-0 px-0 pt-0">
                    <Tooltip
                        content={stripMessageForTooltip(voteSlotMessage)}
                        disabled={!voteBlockIsAppLevel || !voteSlotMessage}
                        side="top"
                    >
                        <span className="inline-block w-full">
                            <Button
                                className="w-full rounded-2xl"
                                size="xl"
                                variant={
                                    vote === "Remove"
                                        ? "destructive"
                                        : "default"
                                }
                                onClick={handleVote}
                                disabled={
                                    isSubmitting ||
                                    voteSlotBlocked ||
                                    approveBlocked
                                }
                            >
                                {voteSlotBlocked || approveBlocked
                                    ? tCreate("brieflyUnavailable")
                                    : vote === "Remove"
                                      ? t("remove")
                                      : t("confirm")}
                                {isSubmitting && (
                                    <Icon
                                        icon={LoaderCircleIcon}
                                        className="animate-spin"
                                    />
                                )}
                            </Button>
                        </span>
                    </Tooltip>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

import { Loader2 } from "lucide-react";
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
import { stripMessageForTooltip } from "@/lib/warnings";
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
    const voteBlockIsAppLevel =
        voteSlotBlocked && voteWarning?.slot !== voteSlot;
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <DialogDescription>
                    {isBulk
                        ? t("bulkBody", { action })
                        : t("singleBody", { action })}
                </DialogDescription>
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
                <DialogFooter>
                    <Tooltip
                        content={stripMessageForTooltip(voteSlotMessage)}
                        disabled={!voteBlockIsAppLevel || !voteSlotMessage}
                        side="top"
                    >
                        <span className="inline-block w-full">
                            <Button
                                className="w-full"
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
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                )}
                            </Button>
                        </span>
                    </Tooltip>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

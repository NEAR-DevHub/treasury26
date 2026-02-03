import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/modal";
import { Button } from "@/components/button";
import { ProposalPermissionKind } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { Loader2 } from "lucide-react";
import { useState } from "react";

interface VoteModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess?: () => void;
    proposalIds: {
        proposalId: number;
        kind: ProposalPermissionKind;
    }[];
    vote: "Approve" | "Reject" | "Remove";
}

export function VoteModal({ isOpen, onClose, onSuccess, proposalIds, vote }: VoteModalProps) {
    const { treasuryId } = useTreasury();
    const { voteProposals } = useNear();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleVote = async () => {
        setIsSubmitting(true);
        try {
            await voteProposals(treasuryId ?? "", proposalIds.map(proposal => ({
                proposalId: proposal.proposalId,
                vote: vote,
                proposalKind: proposal.kind,
            })));
            onSuccess?.();
        } catch (error) {
            console.error(`Failed to ${vote.toLowerCase()} proposal:`, error);
        } finally {
            setIsSubmitting(false);
            onClose();
        }
    }

    const title = vote === "Remove" ? "Remove Request" : "Confirm Your Vote";
    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <DialogDescription>
                    You are about to {vote.toLowerCase()} this request. Once confirmed, this action cannot be undone.
                </DialogDescription>
                <DialogFooter>
                    <Button className="w-full" variant={vote === "Remove" ? "destructive" : "default"} onClick={handleVote} disabled={isSubmitting}>
                        {vote === "Remove" ? "Remove" : "Confirm"}
                        {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

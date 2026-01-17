import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/modal";
import { Button } from "@/components/ui/button";

interface InsufficientBalanceModalProps {
    isOpen: boolean;
    onClose: () => void;
    requiredAmount: string;
    actionType: "vote" | "proposal";
}

export function InsufficientBalanceModal({ isOpen, onClose, requiredAmount, actionType }: InsufficientBalanceModalProps) {
    const actionText = actionType === "vote" ? "cast this vote" : "create this request";
    const actionName = actionType === "vote" ? "Voting" : "Creating a request";

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Insufficient NEAR Balance</DialogTitle>
                </DialogHeader>
                <DialogDescription>
                    You don't have enough NEAR tokens in your wallet to {actionText}. {actionName} requires a minimum balance of <strong>{requiredAmount} NEAR</strong>. Please add NEAR to your wallet and try again.
                </DialogDescription>
                <DialogFooter>
                    <Button className="w-full" onClick={onClose}>
                        Got It
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

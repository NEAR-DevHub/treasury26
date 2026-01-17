import { useState } from "react";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Member {
  accountId: string;
  roles: string[];
}

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  member: Member | null;
  members?: Member[];
  onConfirm: () => Promise<void>;
  validationError?: string;
}

export function DeleteConfirmationModal({
  isOpen,
  onClose,
  member,
  members,
  onConfirm,
  validationError,
}: DeleteConfirmationModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };

  // Determine if this is bulk delete
  const membersToDelete =
    members && members.length > 0 ? members : member ? [member] : [];
  const isBulk = membersToDelete.length > 1;

  return (
    <Dialog
      open={isOpen && membersToDelete.length > 0}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle className="text-left">
            {isBulk
              ? `Remove ${membersToDelete.length} Members`
              : "Remove Member"}
          </DialogTitle>
        </DialogHeader>

        <p className="text-foreground">
          Once approved, this action will permanently remove{" "}
          <span className="font-semibold break-all overflow-wrap-anywhere text-wrap">
            {membersToDelete.map((m) => m.accountId).join(", ")}
          </span>{" "}
          from the treasury and revoke all assigned permissions.
        </p>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block">
              <Button
                type="button"
                onClick={handleConfirm}
                variant="destructive"
                className="w-full"
                disabled={isSubmitting || !!validationError}
              >
                {isSubmitting ? "Creating Proposal..." : "Remove"}
              </Button>
            </span>
          </TooltipTrigger>
          {validationError && (
            <TooltipContent className="max-w-[280px]">
              <p>{validationError}</p>
            </TooltipContent>
          )}
        </Tooltip>
      </DialogContent>
    </Dialog>
  );
}

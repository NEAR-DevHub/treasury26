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
      <DialogContent className="max-w-md p-0 gap-4">
        <DialogHeader>
          <DialogTitle>
            {isBulk
              ? `Remove ${membersToDelete.length} Members`
              : "Remove Member"}
          </DialogTitle>
        </DialogHeader>

        {isBulk ? (
          <div className="space-y-3 px-4">
            <p className="text-foreground">
              Once approved, this action will permanently remove the following
              members from the treasury and revoke all their assigned
              permissions:
            </p>
            <div className="bg-muted/50 rounded-lg p-3 space-y-1 break-all">
              {membersToDelete.map((m) => (
                <div
                  key={m.accountId}
                  className="font-semibold font-mono text-sm"
                >
                  • {m.accountId}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-foreground px-4">
            Once approved, this action will permanently remove{" "}
            <span className="font-semibold">
              {membersToDelete[0]?.accountId}
            </span>{" "}
            from the treasury and revoke all assigned permissions.
          </p>
        )}

        <div className="px-6 pb-4">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

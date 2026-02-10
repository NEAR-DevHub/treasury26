import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/modal";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { NEARN_IO_ACCOUNT } from "../../constants";

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

  // Check if nearn-io.near account is being deleted
  const isNearnAccountBeingDeleted = membersToDelete.some(
    (m) => m.accountId.toLowerCase() === NEARN_IO_ACCOUNT
  );

  return (
    <Dialog
      open={isOpen && membersToDelete.length > 0}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle className="text-left">
            Remove Request
          </DialogTitle>
        </DialogHeader>

        <DialogDescription>



          {isNearnAccountBeingDeleted ? (
            <span>

              Once approved, {NEARN_IO_ACCOUNT} will be permanently removed from the treasury and all associated permissions will be revoked.<br /> <br />  After removal, this account will no longer be able to create requests from NEARN.

            </span>
          ) : <span>
            Once approved, this action will permanently remove{" "}
            <span className="font-semibold break-all overflow-wrap-anywhere text-wrap">
              {membersToDelete.map((m) => m.accountId).join(", ")}
            </span>{" "}
            from the treasury and revoke all assigned permissions.</span>}
        </DialogDescription>
        <DialogFooter>
          <div className="w-full">
            <ButtonWithTooltip
              type="button"
              onClick={handleConfirm}
              variant="destructive"
              className="w-full"
              disabled={isSubmitting || !!validationError}
              tooltipMessage={validationError}
            >
              {isSubmitting ? "Creating Proposal..." : "Remove"}
            </ButtonWithTooltip>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

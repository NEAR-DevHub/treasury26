import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/button";

interface Member {
  accountId: string;
  roles: string[];
}

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  member: Member | null;
  onConfirm: () => Promise<void>;
}

export function DeleteConfirmationModal({ isOpen, onClose, member, onConfirm }: DeleteConfirmationModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen || !member) return null;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-lg shadow-xl max-w-md w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-3 border-b-2">
          <h2 className="text-xl font-semibold">Remove Member</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          <p className="text-foreground">
            Once approved, this action will permanently remove{" "}
            <span className="font-semibold">{member.accountId}</span>{" "}
            from the treasury and revoke all assigned permissions.
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6">
          <Button
            type="button"
            onClick={handleConfirm}
            variant="destructive"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating Proposal..." : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}


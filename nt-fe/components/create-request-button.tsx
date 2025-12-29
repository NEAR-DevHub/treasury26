import { Button } from "@/components/button";
import { Loader2 } from "lucide-react";

interface CreateRequestButtonProps {
  isSubmitting: boolean;
  isAuthorized: boolean;
  accountId: string | null;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  permissionMessage?: string;
  submittingMessage?: string;
  idleMessage?: string;
}

export function CreateRequestButton({
  isSubmitting,
  isAuthorized,
  accountId,
  disabled = false,
  onClick,
  type = "button",
  className = "w-full h-10",
  permissionMessage = "You don't have permission to create this request",
  submittingMessage = "Creating Proposal...",
  idleMessage = "Create Request",
}: CreateRequestButtonProps) {
  const isDisabled = disabled || isSubmitting || !isAuthorized || !accountId;

  return (
    <Button
      type={type}
      onClick={onClick}
      className={className}
      disabled={isDisabled}
    >
      {isSubmitting ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {submittingMessage}
        </>
      ) : !accountId ? (
        "Sign in required"
      ) : !isAuthorized ? (
        permissionMessage
      ) : (
        idleMessage
      )}
    </Button>
  );
}


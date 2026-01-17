import { Button } from "@/components/button";
import { Loader2 } from "lucide-react";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryPolicy, useTokenBalance } from "@/hooks/use-treasury-queries";
import { useMemo, useState } from "react";
import { hasPermission } from "@/lib/config-utils";
import { InsufficientBalanceModal } from "@/features/proposals/components/insufficient-balance-modal";
import Big from "big.js";

interface PermissionRequirement {
  kind: string;
  action: string;
}

interface CreateRequestButtonProps {
  isSubmitting?: boolean;
  permissions?: PermissionRequirement | PermissionRequirement[];
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  idleMessage?: string;
}

const MIN_BALANCE_BUFFER = "0.03";

export function CreateRequestButton({
  isSubmitting = false,
  permissions,
  disabled = false,
  onClick,
  type = "button",
  className = "w-full h-10",
  idleMessage = "Create Request",
}: CreateRequestButtonProps) {
  const { accountId } = useNear();
  const { selectedTreasury } = useTreasury();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const { data: nearBalance } = useTokenBalance(accountId, "near", "near");
  const [showInsufficientBalanceModal, setShowInsufficientBalanceModal] = useState(false);

  const isAuthorized = useMemo(() => {
    if (!permissions || !policy || !accountId) return false;
    const requirements = Array.isArray(permissions) ? permissions : [permissions];
    return requirements.some((req) =>
      hasPermission(policy, accountId, req.kind, req.action)
    );
  }, [permissions, policy, accountId]);

  const requiredAmount = useMemo(() => {
    const proposalBond = policy?.proposal_bond || "0";
    const bondInNear = Big(proposalBond).div(Big(10).pow(24));
    return bondInNear.plus(MIN_BALANCE_BUFFER).toFixed(2);
  }, [policy?.proposal_bond]);

  const hasInsufficientBalance = useMemo(() => {
    if (!nearBalance) return false;
    const balanceInNear = Big(nearBalance.balance).div(Big(10).pow(24));
    return balanceInNear.lt(requiredAmount);
  }, [nearBalance, requiredAmount]);

  const isDisabled = disabled || isSubmitting || !isAuthorized || !accountId;

  const handleClick = () => {
    if (hasInsufficientBalance) {
      setShowInsufficientBalanceModal(true);
      return;
    }
    onClick?.();
  };

  return (
    <>
      <Button
        type={hasInsufficientBalance ? "button" : type}
        onClick={handleClick}
        className={className}
        disabled={isDisabled}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating Proposal...
          </>
        ) : !accountId ? (
          "Connect your wallet"
        ) : !isAuthorized ? (
          "You don't have permission to create a request"
        ) : (
          idleMessage
        )}
      </Button>
      <InsufficientBalanceModal
        isOpen={showInsufficientBalanceModal}
        onClose={() => setShowInsufficientBalanceModal(false)}
        requiredAmount={requiredAmount}
        actionType="proposal"
      />
    </>
  );
}


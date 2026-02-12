import { Button } from "@/components/button";
import { Loader2 } from "lucide-react";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useSubscription } from "@/hooks/use-subscription";
import { useMemo } from "react";
import { hasPermission } from "@/lib/config-utils";

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
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { data: subscription } = useSubscription(treasuryId);

    const isAuthorized = useMemo(() => {
        if (!permissions || !policy || !accountId) return false;
        const requirements = Array.isArray(permissions)
            ? permissions
            : [permissions];
        return requirements.some((req) =>
            hasPermission(policy, accountId, req.kind, req.action),
        );
    }, [permissions, policy, accountId]);
    const hasSponsoredTransactions = useMemo(() => {
        if (!subscription) return true;

        const totalSponsored =
            subscription.planConfig.limits.gasCoveredTransactions;
        if (totalSponsored === null) return true;

        return subscription.gasCoveredTransactions > 0;
    }, [subscription]);

    const isDisabled =
        disabled ||
        isSubmitting ||
        !isAuthorized ||
        !accountId ||
        !hasSponsoredTransactions;

    return (
        <>
            <Button
                type={type}
                onClick={onClick}
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
                ) : !hasSponsoredTransactions ? (
                    "No sponsored transactions remaining"
                ) : !isAuthorized ? (
                    "You don't have permission to create a request"
                ) : (
                    idleMessage
                )}
            </Button>
        </>
    );
}

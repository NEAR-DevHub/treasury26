"use client";

import { Button } from "@/components/button";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useSubscription } from "@/hooks/use-subscription";
import { useMemo } from "react";
import { hasPermission } from "@/lib/config-utils";
import { useSlotBlock } from "@/hooks/use-warnings";
import { stripMessageForTooltip } from "@/lib/warnings";
import { Tooltip } from "@/components/tooltip";

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
    loadingMessage?: string;
}

export function CreateRequestButton({
    isSubmitting = false,
    permissions,
    disabled = false,
    onClick,
    type = "button",
    className = "w-full h-10",
    idleMessage,
    loadingMessage,
}: CreateRequestButtonProps) {
    const tAuth = useTranslations("auth");
    const tCreate = useTranslations("createRequestButton");
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { data: subscription } = useSubscription(treasuryId);
    // Proposal creation is paused when the `action.create-proposal` slot (or an
    // app-wide outage) is critical. This covers every create-request flow.
    const { blocked: proposalBlocked, message: blockedMessage } = useSlotBlock(
        "action.create-proposal",
    );

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
        !hasSponsoredTransactions ||
        proposalBlocked;

    const button = (
        <Button
            type={type}
            onClick={onClick}
            className={className}
            disabled={isDisabled}
        >
            {isSubmitting ? (
                <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {loadingMessage ?? idleMessage ?? tCreate("idle")}
                </>
            ) : proposalBlocked ? (
                tCreate("paused")
            ) : !accountId ? (
                tAuth("noWallet")
            ) : !hasSponsoredTransactions ? (
                tAuth("noSponsoredTransactions")
            ) : !isAuthorized ? (
                tCreate("noPermission")
            ) : (
                (idleMessage ?? tCreate("idle"))
            )}
        </Button>
    );

    if (proposalBlocked && blockedMessage) {
        return (
            <Tooltip
                content={stripMessageForTooltip(blockedMessage)}
                side="top"
            >
                <span className="inline-block w-full">{button}</span>
            </Tooltip>
        );
    }

    return button;
}

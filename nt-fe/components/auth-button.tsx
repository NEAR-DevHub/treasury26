import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useSubscription } from "@/hooks/use-subscription";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useSlotBlock } from "@/hooks/use-warnings";
import {
    getApproversAndThreshold,
    hasPermission,
    isAnyMember,
} from "@/lib/config-utils";
import type { ProposalKind } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { stripMessageForTooltip } from "@/lib/warnings";
import { useNear } from "@/stores/near-store";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

interface AuthButtonProps extends React.ComponentProps<typeof Button> {
    permissionKind: string;
    permissionAction: string;
    balanceCheck?: {
        withProposalBond?: boolean;
    };
    tooltip?: string; // Tooltip content
    tooltipProps?: Omit<
        React.ComponentProps<typeof Tooltip>,
        "children" | "content"
    >; // Additional tooltip props (disabled, contentProps, etc.)
}

export function useNoVoteMessage() {
    const t = useTranslations("auth");
    return t("noVote");
}

interface ErrorMessageProps extends React.ComponentProps<typeof Button> {
    message: string;
}

function ErrorMessage({
    message,
    className,
    children,
    ...props
}: ErrorMessageProps) {
    const isIconSize =
        props.size === "icon" ||
        props.size === "icon-sm" ||
        props.size === "icon-lg";
    return (
        <Button
            {...props}
            disabled
            tooltipContent={message}
            aria-disabled
            className={cn(
                isIconSize
                    ? "shrink-0 opacity-50 cursor-not-allowed"
                    : "w-full shrink opacity-50 cursor-not-allowed",
                className,
            )}
        >
            {children}
        </Button>
    );
}

export function AuthButton({
    permissionKind,
    permissionAction,
    children,
    disabled,
    balanceCheck,
    onClick,
    tooltip,
    tooltipContent,
    tooltipProps,
    ...props
}: AuthButtonProps) {
    const t = useTranslations("auth");
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { data: subscription } = useSubscription(treasuryId);
    const isCreateProposalAction = permissionAction === "AddProposal";
    const {
        blocked: createProposalBlocked,
        message: createProposalBlockedMessage,
    } = useSlotBlock("action.create-proposal");
    const proposalBlocked = isCreateProposalAction && createProposalBlocked;
    const hasAccess = useMemo(() => {
        if (!accountId) return false;
        if (permissionKind === "any") return isAnyMember(policy, accountId);
        return hasPermission(
            policy,
            accountId,
            permissionKind,
            permissionAction,
        );
    }, [policy, accountId, permissionKind, permissionAction]);
    const hasSponsoredTransactions = useMemo(() => {
        if (!subscription) return true;

        const totalSponsored =
            subscription.planConfig.limits.gasCoveredTransactions;
        if (totalSponsored === null) return true;

        return subscription.gasCoveredTransactions > 0;
    }, [subscription]);

    if (!accountId) {
        return (
            <ErrorMessage message={t("noWallet")} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (!hasAccess) {
        return (
            <ErrorMessage message={t("noPermission")} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (!hasSponsoredTransactions) {
        return (
            <ErrorMessage message={t("noSponsoredTransactions")} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (proposalBlocked) {
        return (
            <ErrorMessage
                message={
                    stripMessageForTooltip(createProposalBlockedMessage) ||
                    t("noPermission")
                }
                {...props}
            >
                {children}
            </ErrorMessage>
        );
    }

    return (
        <>
            {tooltip || tooltipContent ? (
                <Button
                    {...props}
                    disabled={disabled}
                    onClick={onClick}
                    tooltipContent={tooltip || tooltipContent}
                >
                    {children}
                </Button>
            ) : (
                <Button {...props} disabled={disabled} onClick={onClick}>
                    {children}
                </Button>
            )}
        </>
    );
}

interface AuthButtonWithProposalProps
    extends React.ComponentProps<typeof Button> {
    proposalKind: ProposalKind;
    isDeleteCheck?: boolean;
    tooltip?: string; // Tooltip content
    tooltipProps?: Omit<
        React.ComponentProps<typeof Tooltip>,
        "children" | "content"
    >;
}

export function AuthButtonWithProposal({
    proposalKind,
    isDeleteCheck = false,
    children,
    disabled,
    onClick,
    tooltip,
    tooltipProps,
    ...props
}: AuthButtonWithProposalProps) {
    const t = useTranslations("auth");
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { data: subscription } = useSubscription(treasuryId);

    const hasAccess = useMemo(() => {
        if (!policy || !accountId) return false;
        const { approverAccounts } = getApproversAndThreshold(
            policy,
            accountId,
            proposalKind,
            isDeleteCheck,
        );
        return approverAccounts.includes(accountId);
    }, [policy, accountId, proposalKind, isDeleteCheck]);
    const hasSponsoredTransactions = useMemo(() => {
        if (!subscription) return true;

        const totalSponsored =
            subscription.planConfig.limits.gasCoveredTransactions;
        if (totalSponsored === null) return true;

        return subscription.gasCoveredTransactions > 0;
    }, [subscription]);

    if (!accountId) {
        return (
            <ErrorMessage message={t("noWallet")} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (!hasAccess) {
        return (
            <ErrorMessage message={t("noPermission")} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (!hasSponsoredTransactions) {
        return (
            <ErrorMessage message={t("noSponsoredTransactions")} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    return (
        <>
            {tooltip ? (
                <Tooltip content={tooltip} {...tooltipProps}>
                    <span className="w-full">
                        <Button
                            {...props}
                            className="w-full"
                            disabled={disabled}
                            onClick={onClick}
                        >
                            {children}
                        </Button>
                    </span>
                </Tooltip>
            ) : (
                <span className="w-full">
                    <Button {...props} disabled={disabled} onClick={onClick}>
                        {children}
                    </Button>
                </span>
            )}
        </>
    );
}

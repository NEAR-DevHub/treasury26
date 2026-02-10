import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { hasPermission, getApproversAndThreshold } from "@/lib/config-utils";
import { ProposalKind } from "@/lib/proposals-api";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useMemo } from "react";

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

export const NO_WALLET_MESSAGE = "Connect your wallet";
export const NO_PERMISSION_MESSAGE =
    "You don't have permission to perform this action";
export const NO_VOTE_MESSAGE = "You have already voted on this proposal";

interface ErrorMessageProps extends React.ComponentProps<typeof Button> {
    message: string;
}

function ErrorMessage({ message, children, ...props }: ErrorMessageProps) {
    return (
        <Tooltip content={message}>
            <span className={props.className}>
                <Button {...props} className="w-full" disabled>
                    {children}
                </Button>
            </span>
        </Tooltip>
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
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const hasAccess = useMemo(() => {
        return !!(
            accountId &&
            hasPermission(policy, accountId, permissionKind, permissionAction)
        );
    }, [policy, accountId, permissionKind, permissionAction]);

    if (!accountId) {
        return (
            <ErrorMessage message={NO_WALLET_MESSAGE} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (!hasAccess) {
        return (
            <ErrorMessage message={NO_PERMISSION_MESSAGE} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    return (
        <>
            {tooltip || tooltipContent ? (
                <Tooltip content={tooltip || tooltipContent} {...tooltipProps}>
                    <span>
                        <Button
                            {...props}
                            disabled={disabled}
                            onClick={onClick}
                        >
                            {children}
                        </Button>
                    </span>
                </Tooltip>
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
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);

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

    if (!accountId) {
        return (
            <ErrorMessage message={NO_WALLET_MESSAGE} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    if (!hasAccess) {
        return (
            <ErrorMessage message={NO_PERMISSION_MESSAGE} {...props}>
                {children}
            </ErrorMessage>
        );
    }

    return (
        <>
            {tooltip ? (
                <Tooltip content={tooltip} {...tooltipProps}>
                    <span>
                        <Button
                            {...props}
                            disabled={disabled}
                            onClick={onClick}
                        >
                            {children}
                        </Button>
                    </span>
                </Tooltip>
            ) : (
                <Button {...props} disabled={disabled} onClick={onClick}>
                    {children}
                </Button>
            )}
        </>
    );
}

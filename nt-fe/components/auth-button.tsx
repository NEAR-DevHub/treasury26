import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { hasPermission, getApproversAndThreshold } from "@/lib/config-utils";
import { ProposalKind } from "@/lib/proposals-api";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useMemo } from "react";

interface AuthButtonProps extends React.ComponentProps<typeof Button> {
    permissionKind: string;
    permissionAction: string;
}

const NO_WALLET_MESSAGE = "Connect your wallet";
const NO_PERMISSION_MESSAGE = "You don’t have permission to perform this action";

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
    ...props
}: AuthButtonProps) {
    const { accountId } = useNear();
    const { selectedTreasury } = useTreasury();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);

    const hasAccess = useMemo(() => {
        return !!(accountId && hasPermission(policy, accountId, permissionKind, permissionAction));
    }, [policy, accountId, permissionKind, permissionAction]);

    if (!accountId) {
        return <ErrorMessage message={NO_WALLET_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    if (!hasAccess) {
        return <ErrorMessage message={NO_PERMISSION_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    return (
        <Button {...props} disabled={disabled}>
            {children}
        </Button>
    );
}

interface AuthButtonWithProposalProps extends React.ComponentProps<typeof Button> {
    proposalKind: ProposalKind;
    isDeleteCheck?: boolean;
}

export function AuthButtonWithProposal({
    proposalKind,
    isDeleteCheck = false,
    children,
    disabled,
    ...props
}: AuthButtonWithProposalProps) {
    const { accountId } = useNear();
    const { selectedTreasury } = useTreasury();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);

    const hasAccess = useMemo(() => {
        if (!policy || !accountId) return false;
        const { approverAccounts } = getApproversAndThreshold(policy, accountId, proposalKind, isDeleteCheck);
        return approverAccounts.includes(accountId);
    }, [policy, accountId, proposalKind, isDeleteCheck]);

    if (!accountId) {
        return <ErrorMessage message={NO_WALLET_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    if (!hasAccess) {
        return <ErrorMessage message={NO_PERMISSION_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    return (
        <Button {...props} disabled={disabled}>
            {children}
        </Button>
    );
}

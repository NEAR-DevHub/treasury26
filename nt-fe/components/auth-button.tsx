import { Policy } from "@/types/policy";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { hasPermission, getApproversAndThreshold, getKindFromProposal } from "@/lib/config-utils";
import { ProposalKind } from "@/lib/proposals-api";

interface AuthButtonProps extends React.ComponentProps<typeof Button> {
    policy: Policy | null | undefined;
    accountId: string | null | undefined;
    permissionKind: string;
    permissionAction: string;
    noPermissionMessage?: string;
}

export function AuthButton({
    policy,
    accountId,
    permissionKind,
    permissionAction,
    noPermissionMessage = "You don't have permission to perform this action",
    children,
    disabled,
    ...props
}: AuthButtonProps) {
    const hasAccess = accountId && hasPermission(policy, accountId, permissionKind, permissionAction);

    if (!hasAccess) {
        return (
            <Tooltip content={noPermissionMessage}>
                <span className={props.className}>
                    <Button {...props} className="w-full" disabled>
                        {children}
                    </Button>
                </span>
            </Tooltip>
        );
    }

    return (
        <Button {...props} disabled={disabled}>
            {children}
        </Button>
    );
}

interface AuthButtonWithProposalProps extends React.ComponentProps<typeof Button> {
    policy: Policy | null | undefined;
    accountId: string | null | undefined;
    proposalKind: ProposalKind;
    isDeleteCheck?: boolean;
    noPermissionMessage?: string;
}

export function AuthButtonWithProposal({
    policy,
    accountId,
    proposalKind,
    isDeleteCheck = false,
    noPermissionMessage = "You don't have permission to vote on this proposal",
    children,
    disabled,
    ...props
}: AuthButtonWithProposalProps) {
    const hasAccess = (() => {
        if (!policy || !accountId) return false;
        const { approverAccounts } = getApproversAndThreshold(policy, accountId, proposalKind, isDeleteCheck);
        return approverAccounts.includes(accountId);
    })();


    if (!hasAccess) {
        return (
            <Tooltip content={noPermissionMessage}>
                <span className={props.className}>
                    <Button {...props} className="w-full" disabled>
                        {children}
                    </Button>
                </span>
            </Tooltip>
        );
    }

    return (
        <Button {...props} disabled={disabled}>
            {children}
        </Button>
    );
}

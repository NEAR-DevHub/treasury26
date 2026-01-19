import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { hasPermission, getApproversAndThreshold } from "@/lib/config-utils";
import { ProposalKind } from "@/lib/proposals-api";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryPolicy, useTokenBalance } from "@/hooks/use-treasury-queries";
import { useMemo, useState } from "react";
import { InsufficientBalanceModal } from "@/features/proposals/components/insufficient-balance-modal";
import Big from "big.js";

interface AuthButtonProps extends React.ComponentProps<typeof Button> {
    permissionKind: string;
    permissionAction: string;
    balanceCheck?: {
        withProposalBond?: boolean;
    };
}

const NO_WALLET_MESSAGE = "Connect your wallet";
const NO_PERMISSION_MESSAGE = "You don't have permission to perform this action";
const MIN_BALANCE_BUFFER = "0.03";

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
    ...props
}: AuthButtonProps) {
    const { accountId } = useNear();
    const { selectedTreasury } = useTreasury();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);
    const { data: nearBalance } = useTokenBalance(accountId, "near", "near");
    const [showInsufficientBalanceModal, setShowInsufficientBalanceModal] = useState(false);

    const hasAccess = useMemo(() => {
        return !!(accountId && hasPermission(policy, accountId, permissionKind, permissionAction));
    }, [policy, accountId, permissionKind, permissionAction]);

    const requiredAmount = useMemo(() => {
        if (!balanceCheck?.withProposalBond) return MIN_BALANCE_BUFFER;
        const proposalBond = policy?.proposal_bond || "0";
        const bondInNear = Big(proposalBond).div(Big(10).pow(24));
        return bondInNear.plus(MIN_BALANCE_BUFFER).toFixed(2);
    }, [policy?.proposal_bond]);

    const hasInsufficientBalance = useMemo(() => {
        if (!nearBalance || !balanceCheck?.withProposalBond) return false;
        const balanceInNear = Big(nearBalance.balance).div(Big(10).pow(24));
        return balanceInNear.lt(requiredAmount);
    }, [nearBalance, requiredAmount]);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (hasInsufficientBalance) {
            e.preventDefault();
            setShowInsufficientBalanceModal(true);
            return;
        }
        onClick?.(e);
    };

    if (!accountId) {
        return <ErrorMessage message={NO_WALLET_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    if (!hasAccess) {
        return <ErrorMessage message={NO_PERMISSION_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    return (
        <>
            <Button {...props} disabled={disabled} onClick={handleClick}>
                {children}
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

interface AuthButtonWithProposalProps extends React.ComponentProps<typeof Button> {
    proposalKind: ProposalKind;
    isDeleteCheck?: boolean;
}

const MIN_VOTE_BALANCE = "0.03";

export function AuthButtonWithProposal({
    proposalKind,
    isDeleteCheck = false,
    children,
    disabled,
    onClick,
    ...props
}: AuthButtonWithProposalProps) {
    const { accountId } = useNear();
    const { selectedTreasury } = useTreasury();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);
    const { data: nearBalance } = useTokenBalance(accountId, "near", "near");
    const [showInsufficientBalanceModal, setShowInsufficientBalanceModal] = useState(false);

    const hasAccess = useMemo(() => {
        if (!policy || !accountId) return false;
        const { approverAccounts } = getApproversAndThreshold(policy, accountId, proposalKind, isDeleteCheck);
        return approverAccounts.includes(accountId);
    }, [policy, accountId, proposalKind, isDeleteCheck]);

    const hasInsufficientBalance = useMemo(() => {
        if (!nearBalance) return false;
        const balanceInNear = Big(nearBalance.balance).div(Big(10).pow(24));
        return balanceInNear.lt(MIN_VOTE_BALANCE);
    }, [nearBalance]);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (hasInsufficientBalance) {
            e.preventDefault();
            setShowInsufficientBalanceModal(true);
            return;
        }
        onClick?.(e);
    };

    if (!accountId) {
        return <ErrorMessage message={NO_WALLET_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    if (!hasAccess) {
        return <ErrorMessage message={NO_PERMISSION_MESSAGE} {...props}>{children}</ErrorMessage>;
    }

    return (
        <>
            <Button {...props} disabled={disabled} onClick={handleClick}>
                {children}
            </Button>
            <InsufficientBalanceModal
                isOpen={showInsufficientBalanceModal}
                onClose={() => setShowInsufficientBalanceModal(false)}
                requiredAmount={MIN_VOTE_BALANCE}
                actionType="vote"
            />
        </>
    );
}

import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { Info } from "lucide-react";
import { Pill } from "@/components/pill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useNear } from "@/stores/near-store";

interface ApprovalInfoProps {
    variant: "pupil" | "alert";
    requiredVotes?: number;
    side?: "top" | "bottom" | "left" | "right";
    approverAccounts?: string[];
}

const infoText = "Votes required to approve payment-related requests. Editable in Voting settings.";

export function ApprovalInfo({ variant, requiredVotes: requiredVotesProp, approverAccounts: approverAccountsProp, side }: ApprovalInfoProps) {
    const { selectedTreasury } = useTreasury();
    const { accountId } = useNear();
    const { data: policy } = useTreasuryPolicy(requiredVotesProp && approverAccountsProp ? null : selectedTreasury);

    const { requiredVotes, approverAccounts } = requiredVotesProp && approverAccountsProp ? { requiredVotes: requiredVotesProp, approverAccounts: approverAccountsProp } : policy ? getApproversAndThreshold(policy, accountId ?? "", "call", false) : { requiredVotes: 0, approverAccounts: [] };

    if (variant === "pupil") {
        return (
            <Pill title={`Threshold ${requiredVotes} out of ${approverAccounts?.length ?? 0}`} info={infoText} side={side} />
        );
    }

    return (
        <Alert>
            <Info />
            <AlertDescription className="inline-block">
                This payment will require approval from{" "}
                <span className="font-semibold">
                    {requiredVotes}
                </span>{" "}
                treasury members before execution.
            </AlertDescription>
        </Alert>
    );
}

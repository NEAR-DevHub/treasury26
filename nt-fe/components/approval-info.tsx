import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useNear } from "@/stores/near-store";


export function ApprovalInfo({ variant }: { variant: "pupil" | "alert" }) {
    const { selectedTreasury } = useTreasury();
    const { accountId } = useNear();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);

    const { requiredVotes, approverAccounts } = policy ? getApproversAndThreshold(policy, accountId ?? "", "call", false) : { requiredVotes: 0 };

    if (variant === "pupil") {
        return (
            <div className="flex border rounded-md py-[3px] px-2 w-fit text-xs font-medium text-center">
                Threshold {requiredVotes} out of {approverAccounts?.length ?? 0}
            </div>
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

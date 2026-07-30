import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { Pill } from "@/components/pill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";

interface ApprovalInfoProps {
    variant: "pupil" | "alert";
    requiredVotes?: number;
    side?: "top" | "bottom" | "left" | "right";
    approverAccounts?: string[];
}

export function ApprovalInfo({
    variant,
    requiredVotes: requiredVotesProp,
    approverAccounts: approverAccountsProp,
    side,
}: ApprovalInfoProps) {
    const t = useTranslations("approvalInfo");
    const { treasuryId } = useTreasury();
    const { accountId } = useNear();
    const { data: policy } = useTreasuryPolicy(
        requiredVotesProp && approverAccountsProp ? null : treasuryId,
    );

    const { requiredVotes, approverAccounts } =
        requiredVotesProp && approverAccountsProp
            ? {
                  requiredVotes: requiredVotesProp,
                  approverAccounts: approverAccountsProp,
              }
            : policy
              ? getApproversAndThreshold(policy, accountId ?? "", "call", false)
              : { requiredVotes: 0, approverAccounts: [] };

    if (variant === "pupil") {
        return (
            <Pill
                variant="secondary"
                className="rounded-full"
                title={t("thresholdPill", {
                    required: requiredVotes,
                    total: approverAccounts?.length ?? 0,
                })}
                info={t("infoText")}
                side={side}
            />
        );
    }

    return (
        <Alert>
            <Info />
            <AlertDescription className="inline-block">
                {t.rich("alertBody", {
                    required: requiredVotes,
                    bold: (chunks) => (
                        <span className="font-semibold">{chunks}</span>
                    ),
                })}
            </AlertDescription>
        </Alert>
    );
}

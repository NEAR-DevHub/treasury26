import { useTranslations } from "next-intl";
import { TokenCell } from "./token-cell";
import { StakingData } from "../../types/index";
import { useLockupPool, useProfile } from "@/hooks/use-treasury-queries";
import { Proposal } from "@/lib/proposals-api";
import { useStakingFullAmount } from "../../hooks/use-staking-full-amount";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface StakingCellProps {
    data: StakingData;
    proposal: Proposal;
    treasuryId?: string;
    timestamp?: string;
    textOnly?: boolean;
}

export function StakingCell({
    data,
    proposal,
    treasuryId,
    timestamp,
    textOnly = false,
}: StakingCellProps) {
    const t = useTranslations("proposals.expanded");
    const { data: lockupPool } = useLockupPool(
        data.isLockup ? data.receiver : null,
    );
    const validator = data.isLockup ? lockupPool : data.receiver;

    const { amount: resolvedAmount } = useStakingFullAmount(
        data,
        proposal,
        treasuryId,
    );
    const { data: profile } = useProfile(validator);
    const address = profile?.addressBookName ?? validator;

    const showAllLabel = data.isFullAmount && !resolvedAmount;

    if (showAllLabel) {
        return (
            <TitleSubtitleCell
                title={<span>{t("allNear")}</span>}
                subtitle={
                    validator
                        ? t("validatorSubtitle", { address: address ?? "" })
                        : undefined
                }
                timestamp={timestamp}
            />
        );
    }

    const displayAmount =
        data.isFullAmount && resolvedAmount ? resolvedAmount : data.amount;

    return (
        <TokenCell
            data={{
                ...data,
                amount: displayAmount,
                receiver: validator || "",
            }}
            textOnly={textOnly}
            prefix={t("validatorPrefix")}
            timestamp={timestamp}
        />
    );
}

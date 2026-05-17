import { useTranslations } from "next-intl";
import { useLockupPool } from "@/hooks/use-treasury-queries";
import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import Link from "next/link";
import { StakingData } from "../../types/index";
import { Proposal } from "@/lib/proposals-api";
import { useStakingFullAmount } from "../../hooks/use-staking-full-amount";
import { Skeleton } from "@/components/ui/skeleton";

interface StakingExpandedProps {
    data: StakingData;
    proposal: Proposal;
    treasuryId?: string;
}

export function StakingExpanded({
    data,
    proposal,
    treasuryId,
}: StakingExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const { data: lockupPool } = useLockupPool(
        data.isLockup ? data.receiver : null,
    );
    const validator = data.isLockup ? lockupPool : data.receiver;

    const { amount: resolvedAmount, isLoading: resolving } =
        useStakingFullAmount(data, proposal, treasuryId);

    const amountValue = (() => {
        if (data.isFullAmount) {
            if (resolving) {
                return <Skeleton className="h-4 w-24" />;
            }
            if (resolvedAmount) {
                return (
                    <Amount
                        amount={resolvedAmount}
                        showNetworkTooltip
                        tokenId={data.tokenId}
                    />
                );
            }
            return <span>{t("allNear")}</span>;
        }
        return (
            <Amount
                amount={data.amount}
                showNetworkTooltip
                tokenId={data.tokenId}
            />
        );
    })();

    const infoItems: InfoItem[] = [
        {
            label: t("sourceWallet"),
            value: <span>{data.sourceWallet}</span>,
        },
        {
            label: t("amount"),
            value: amountValue,
        },
        {
            label: t("validator"),
            value: (
                <Link href={data.validatorUrl} target="_blank">
                    {validator}
                </Link>
            ),
        },
    ];

    if (data.notes && data.notes !== "") {
        infoItems.push({
            label: t("notes"),
            value: <span>{data.notes}</span>,
        });
    }

    return <InfoDisplay items={infoItems} />;
}

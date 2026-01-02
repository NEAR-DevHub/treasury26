import { useLockupPool } from "@/hooks/use-treasury-queries";
import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import Link from "next/link";
import { StakingData } from "../../types/index";

interface StakingExpandedProps {
    data: StakingData;
}

export function StakingExpanded({ data }: StakingExpandedProps) {
    const { data: lockupPool } = useLockupPool(data.isLockup ? data.receiver : null);
    const validator = data.isLockup ? lockupPool : data.receiver;

    const infoItems: InfoItem[] = [
        {
            label: "Source Wallet",
            value: <span>{data.sourceWallet}</span>
        },
        {
            label: "Amount",
            value: <Amount amount={data.amount} tokenId={data.tokenId} />
        },
        {
            label: "Validator",
            value: <Link href={data.validatorUrl} target="_blank">{validator}</Link>
        }
    ];

    if (data.notes && data.notes !== "") {
        infoItems.push({ label: "Notes", value: <span>{data.notes}</span> });
    }

    return (
        <InfoDisplay items={infoItems} />
    );
}

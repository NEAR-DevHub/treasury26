import { TokenCell } from "./token-cell";
import { StakingData } from "../../types/index";
import { useLockupPool } from "@/hooks/use-treasury-queries";

interface StakingCellProps {
    data: StakingData;
    timestamp?: string;
    textOnly?: boolean;
}

export function StakingCell({ data, timestamp, textOnly = false }: StakingCellProps) {
    const { data: lockupPool } = useLockupPool(data.isLockup ? data.receiver : null);
    const validator = data.isLockup ? lockupPool : data.receiver;
    return (
        <TokenCell data={{ ...data, receiver: validator || "" }} textOnly={textOnly} prefix="Validator:" timestamp={timestamp} />
    );
}

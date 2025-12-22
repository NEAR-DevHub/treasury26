import { TokenCell } from "./token-cell";
import { StakingData } from "../../types/index";
import { useLockupPool } from "@/hooks/use-treasury-queries";

interface StakingCellProps {
    data: StakingData;
}

export function StakingCell({ data }: StakingCellProps) {
    const { data: lockupPool } = useLockupPool(data.isLockup ? data.receiver : null);
    const validator = data.isLockup ? lockupPool : data.receiver;
    return (
        <TokenCell data={{ ...data, receiver: validator || "" }} prefix="Validator:" />
    );
}

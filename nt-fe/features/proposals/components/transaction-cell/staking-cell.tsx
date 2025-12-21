import { TokenCell } from "./token-cell";
import { StakingData } from "../../types/index";

interface StakingCellProps {
    data: StakingData;
}

export function StakingCell({ data }: StakingCellProps) {
    return (
        <TokenCell data={data} />
    );
}

import { InfoAlert } from "@/components/info-alert";
import { InsufficientBalanceInfo } from "../hooks/use-proposal-insufficient-balance";

export function NotEnoughBalance({
    insufficientBalanceInfo,
}: {
    insufficientBalanceInfo: InsufficientBalanceInfo;
}) {
    if (!insufficientBalanceInfo.hasInsufficientBalance) return null;
    return (
        <InfoAlert
            className="inline-flex"
            message={
                <span>
                    This request can&apos;t be approved because the treasury has
                    insufficient{" "}
                    <strong>{insufficientBalanceInfo.tokenSymbol}</strong>{" "}
                    balance. Add{" "}
                    <strong>
                        {insufficientBalanceInfo.differenceDisplay}{" "}
                        {insufficientBalanceInfo.tokenSymbol}
                    </strong>{" "}
                    to{" "}
                    {insufficientBalanceInfo.type === "bond"
                        ? "cover proposal bond costs"
                        : "continue"}
                    .
                </span>
            }
        />
    );
}

import { useTranslations } from "next-intl";
import { BALANCE_MASK, useIsBalanceMasked } from "@/components/balance-mask";
import { InfoAlert } from "@/components/info-alert";
import { InsufficientBalanceInfo } from "../hooks/use-proposal-insufficient-balance";

export function NotEnoughBalance({
    insufficientBalanceInfo,
}: {
    insufficientBalanceInfo: InsufficientBalanceInfo;
}) {
    const t = useTranslations("proposals.insufficientBalance");
    const isMasked = useIsBalanceMasked();
    if (!insufficientBalanceInfo.hasInsufficientBalance) return null;

    if (insufficientBalanceInfo.type === "no-asset") {
        return (
            <InfoAlert
                className="inline-flex"
                message={<span>{t("noAsset")}</span>}
            />
        );
    }

    const messageKey =
        insufficientBalanceInfo.type === "bond"
            ? "bond"
            : insufficientBalanceInfo.type === "staked"
              ? "staked"
              : insufficientBalanceInfo.type === "readyToWithdraw"
                ? "readyToWithdraw"
                : "continue";
    const symbol = insufficientBalanceInfo.tokenSymbol ?? "";
    const amount = isMasked
        ? BALANCE_MASK
        : (insufficientBalanceInfo.differenceDisplay ?? "");

    return (
        <InfoAlert
            className="inline-flex"
            message={
                <span>
                    {t.rich(messageKey, {
                        symbol,
                        amount,
                        token: (chunks) => <strong>{chunks}</strong>,
                    })}
                </span>
            }
        />
    );
}

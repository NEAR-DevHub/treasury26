import { useTranslations } from "next-intl";
import { Proposal } from "@/lib/proposals-api";
import { FunctionCallCell } from "./function-call-cell";
import { ChangePolicyCell } from "./change-policy-cell";
import { TokenCell } from "./token-cell";
import { BatchPaymentCell } from "./batch-payment-cell";
import { StakingCell } from "./staking-cell";
import { SwapCell } from "./swap-cell";
import { extractProposalData } from "../../utils/proposal-extractors";
import {
    PaymentRequestData,
    BatchPaymentRequestData,
    ConfidentialRequestData,
    FunctionCallData,
    StakingData,
    VestingData,
    SwapRequestData,
    UnknownData,
} from "../../types/index";
import { ConfidentialRequestCell } from "./confidential-request-cell";
import { ChangeConfigCell } from "./change-config-cell";
import { useTreasury } from "@/hooks/use-treasury";
import { SubtitleSuffixContext } from "./title-subtitle-cell";

interface TransactionCellProps {
    proposal: Proposal;
    textOnly?: boolean;
    withDate?: boolean;
    subtitleSuffix?: React.ReactNode;
}

/**
 * Renders the transaction cell based on proposal type
 */
export function TransactionCell({
    proposal,
    subtitleSuffix,
    withDate,
    textOnly = false,
}: TransactionCellProps) {
    return (
        <SubtitleSuffixContext.Provider value={subtitleSuffix}>
            <TransactionCellSwitch
                proposal={proposal}
                withDate={withDate}
                textOnly={textOnly}
            />
        </SubtitleSuffixContext.Provider>
    );
}

function TransactionCellSwitch({
    proposal,
    withDate,
    textOnly = false,
}: Omit<TransactionCellProps, "subtitleSuffix">) {
    const t = useTranslations("proposals.expanded");
    const { treasuryId } = useTreasury();
    const { type, data } = extractProposalData(proposal, treasuryId);
    const timestamp = withDate ? proposal.submission_time : undefined;

    switch (type) {
        case "Payment Request": {
            const paymentData = data as PaymentRequestData;
            return (
                <TokenCell
                    data={paymentData}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Confidential Request": {
            const confidentialData = data as ConfidentialRequestData;
            return (
                <ConfidentialRequestCell
                    data={confidentialData}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Batch Payment Request": {
            const batchPaymentData = data as BatchPaymentRequestData;
            return (
                <BatchPaymentCell
                    data={batchPaymentData}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Function Call": {
            const functionCallData = data as FunctionCallData;
            return (
                <FunctionCallCell
                    data={functionCallData}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Change Policy": {
            return (
                <ChangePolicyCell
                    proposal={proposal}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Update General Settings":
            return (
                <ChangeConfigCell
                    proposal={proposal}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        case "Earn NEAR":
        case "Unstake NEAR":
        case "Withdraw Earnings": {
            const stakingData = data as StakingData;
            return (
                <StakingCell
                    data={stakingData}
                    proposal={proposal}
                    treasuryId={treasuryId ?? undefined}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Vesting": {
            const vestingData = data as VestingData;
            return (
                <TokenCell
                    data={vestingData}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Exchange": {
            const swapData = data as SwapRequestData;
            return (
                <SwapCell
                    data={swapData}
                    timestamp={timestamp}
                    textOnly={textOnly}
                />
            );
        }
        case "Unsupported": {
            const unknownData = data as UnknownData;
            return (
                <div className="flex flex-col gap-1">
                    <span className="font-medium">
                        {t("unsupportedProposal")}{" "}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {unknownData.proposalType}
                    </span>
                </div>
            );
        }
        default:
            return (
                <div className="flex flex-col gap-1">
                    <span className="font-medium">
                        {t("unsupportedProposal")}{" "}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {type}
                    </span>
                </div>
            );
    }
}

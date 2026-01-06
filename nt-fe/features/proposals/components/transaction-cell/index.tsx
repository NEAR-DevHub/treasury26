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
  FunctionCallData,
  ChangePolicyData,
  StakingData,
  VestingData,
  SwapRequestData,
  ChangeConfigData,
  UnknownData,
} from "../../types/index";
import { ChangeConfigCell } from "./change-config-cell";
import { Policy } from "@/types/policy";
import { TreasuryConfig } from "@/lib/api";

interface TransactionCellProps {
  proposal: Proposal;
  policy: Policy;
  config?: TreasuryConfig | null;
}

/**
 * Renders the transaction cell based on proposal type
 */
export function TransactionCell({ proposal, policy, config }: TransactionCellProps) {
  const { type, data } = extractProposalData(proposal, policy, config);

  switch (type) {
    case "Payment Request": {
      const paymentData = data as PaymentRequestData;
      return <TokenCell data={paymentData} />;
    }
    case "Batch Payment Request": {
      const batchPaymentData = data as BatchPaymentRequestData;
      return <BatchPaymentCell data={batchPaymentData} />;
    }
    case "Function Call": {
      const functionCallData = data as FunctionCallData;
      return <FunctionCallCell data={functionCallData} />;
    }
    case "Change Policy": {
      const policyData = data as ChangePolicyData;
      return <ChangePolicyCell data={policyData} />;
    }
    case "Update General Settings":
      const configData = data as ChangeConfigData;
      return <ChangeConfigCell data={configData} />;
    case "Earn NEAR":
    case "Unstake NEAR":
    case "Withdraw Earnings": {
      const stakingData = data as StakingData;
      return <StakingCell data={stakingData} />;
    }
    case "Vesting": {
      const vestingData = data as VestingData;
      return <TokenCell data={vestingData} />;
    }
    case "Exchange": {
      const swapData = data as SwapRequestData;
      return <SwapCell data={swapData} />;
    }
    case "Unsupported": {
      const unknownData = data as UnknownData;
      return <div className="flex flex-col gap-1">
        <span className="font-medium">Unsupported proposal type </span>
        <span className="text-xs text-muted-foreground">{unknownData.proposalType}</span>
      </div>
    }
    default:
      return (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Unsupported proposal type </span>
          <span className="text-xs text-muted-foreground">{type}</span>
        </div>
      );
  }
}

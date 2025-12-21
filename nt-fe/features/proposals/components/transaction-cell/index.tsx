import { Proposal } from "@/lib/proposals-api";
import { FunctionCallCell } from "./function-call-cell";
import { ChangePolicyCell } from "./change-policy-cell";
import { TokenCell } from "./token-cell";
import { StakingCell } from "./staking-cell";
import { SwapCell } from "./swap-cell";
import { extractProposalData } from "../../utils/proposal-extractors";
import {
  PaymentRequestData,
  FunctionCallData,
  ChangePolicyData,
  StakingData,
  VestingData,
  SwapRequestData,
} from "../../types/index";

interface TransactionCellProps {
  proposal: Proposal;
}

/**
 * Renders the transaction cell based on proposal type
 */
export function TransactionCell({ proposal }: TransactionCellProps) {
  const { type, data } = extractProposalData(proposal);

  switch (type) {
    case "Payment Request": {
      const paymentData = data as PaymentRequestData;
      return <TokenCell data={paymentData} />;
    }
    case "Function Call": {
      const functionCallData = data as FunctionCallData;
      return <FunctionCallCell data={functionCallData} />;
    }
    case "Change Policy": {
      const policyData = data as ChangePolicyData;
      return <ChangePolicyCell data={policyData} />;
    }
    case "Change Config":
      return "Updated Treasury Config";
    case "Staking":
    case "Withdraw": {
      const stakingData = data as StakingData;
      return <StakingCell data={stakingData} />;
    }
    case "Vesting": {
      const vestingData = data as VestingData;
      return <TokenCell data={vestingData} />;
    }
    case "Swap Request": {
      const swapData = data as SwapRequestData;
      return <SwapCell data={swapData} />;
    }
    default:
      return (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Unknown</span>
          <span className="text-xs text-muted-foreground">Unknown proposal type</span>
        </div>
      );
  }
}

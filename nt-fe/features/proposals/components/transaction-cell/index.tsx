import { Proposal } from "@/lib/proposals-api";
import { FunctionCallCell } from "./function-call-cell";
import { ChangePolicyCell } from "./change-policy-cell";
import { TokenCell } from "./token-cell";
import { decodeArgs } from "@/lib/utils";
import { getProposalType } from "../../utils/proposal-utils";
import { fetchTransferFromDirect, fetchTransferFromFT } from "../expanded-view/transfer-expanded";
import { StakingCell } from "./staking-cell";

interface TransactionCellProps {
  proposal: Proposal;
}

/**
 * Renders the transaction cell based on proposal type
 */
export function TransactionCell({ proposal }: TransactionCellProps) {
  const type = getProposalType(proposal);

  switch (type) {
    case "Payment Request":
      let data;
      if ('Transfer' in proposal.kind) {
        data = fetchTransferFromDirect(proposal);
      } else if ('FunctionCall' in proposal.kind) {
        data = fetchTransferFromFT(proposal);
      } else {
        return null;
      }
      return <TokenCell tokenId={data?.tokenId || "near"} amount={data?.amount || "0"} receiver={data?.receiver || ""} />;
    case "Function Call":
      return <FunctionCallCell proposal={proposal} />;
    case "Change Policy":
      return <ChangePolicyCell proposal={proposal} />;
    case "Change Config":
      return "Updated Treasury Config";
    case "Staking":
      return <StakingCell proposal={proposal} />;
    case "Vesting":
      if (!('FunctionCall' in proposal.kind)) return null;
      const functionCall = proposal.kind.FunctionCall;
      if (!functionCall.actions.some(action => action.method_name === 'create')) return null;
      const action = functionCall.actions[0];
      if (!action) return null;
      const args = decodeArgs(action.args);
      if (!args) return null;
      const recipient = args?.owner_account_id;
      const amount = action.deposit;
      return <TokenCell tokenId="near" amount={amount} receiver={recipient || 'contributor.near'} />;
    default:
      return (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Unknown</span>
          <span className="text-xs text-muted-foreground">Unknown proposal type</span>
        </div>
      );
  }
}

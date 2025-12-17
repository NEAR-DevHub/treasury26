import { useToken } from "@/hooks/use-treasury-queries";
import { Proposal } from "@/lib/proposals-api";
import { decodeArgs, decodeProposalDescription, formatNearAmount } from "@/lib/utils";
import { Amount } from "../amount";
import { InfoDisplay } from "@/components/info-display";
interface TransferExpandedProps {
  proposal: Proposal;
}

export function TransferExpanded({ proposal }: TransferExpandedProps) {
  let data;
  if ('Transfer' in proposal.kind) {
    data = fetchTransferFromDirect(proposal);
  } else if ('FunctionCall' in proposal.kind) {
    data = fetchTransferFromFT(proposal);
  } else {
    return null;
  }

  const notes = decodeProposalDescription("notes", proposal.description);

  const infoItems = [
    {
      label: "Recipient",
      value: data?.receiver
    },
    {
      label: "Amount",
      value: <Amount amount={data?.amount || "0"} tokenId={data?.tokenId || "near"} />
    }
  ];
  if (notes && notes !== "") {
    infoItems.push({ label: "Notes", value: notes });
  }
  return (
    <InfoDisplay items={infoItems} />
  );
}

export function fetchTransferFromDirect(proposal: Proposal) {
  if (!('Transfer' in proposal.kind)) return null;
  const transfer = proposal.kind.Transfer;
  const tokenId = transfer.token_id.length > 0 ? transfer.token_id : "near";
  return {
    tokenId,
    amount: transfer.amount,
    receiver: transfer.receiver_id
  };
}

export function fetchTransferFromFT(proposal: Proposal) {
  if (!('FunctionCall' in proposal.kind)) return null;
  const functionCall = proposal.kind.FunctionCall;
  const actions = functionCall.actions;
  const action = actions.find(a => a.method_name === "ft_transfer" || a.method_name === "ft_transfer_call");
  if (!action) return null;
  const args = decodeArgs(action.args);
  if (!args) return null;
  return {
    tokenId: functionCall.receiver_id,
    amount: args.amount,
    receiver: args.receiver_id
  }
}

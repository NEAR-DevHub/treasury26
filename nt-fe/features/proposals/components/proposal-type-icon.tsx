import { FileText, Shield, Clock, CreditCard, TerminalSquare, Database } from "lucide-react";
import { Proposal } from "@/lib/proposals-api";
import { getProposalUIKind } from "../utils/proposal-utils";

interface ProposalTypeIconProps {
  proposal: Proposal;
  className?: string;
}

export function ProposalTypeIcon({ proposal }: ProposalTypeIconProps) {
  const type = getProposalUIKind(proposal);

  switch (type) {
    case "Payment Request":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-blue-500/10 bg-blue-100">
          <CreditCard className="size-5 dark:text-blue-300 text-blue-800" />
        </div>
      );
    case "Function Call":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-blue-500/10 bg-blue-100">
          <TerminalSquare className="size-5 dark:text-blue-400 text-blue-800" />
        </div>
      );
    case "Change Policy":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-amber-500/10 bg-amber-100">
          <Shield className="size-5 dark:text-amber-300 text-amber-800" />
        </div>
      );
    case "Vesting":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-indigo-500/10 bg-indigo-100">
          <Clock className="size-5 dark:text-indigo-300 text-indigo-800" />
        </div>
      );
    case "Staking":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-green-500/10 bg-green-100">
          <Database className="size-5 dark:text-green-300 text-green-700" />
        </div>
      );
    case "Swap Request":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-pink-500/10 bg-pink-100">
          <CreditCard className="size-5 dark:text-pink-300 text-pink-800" />
        </div>
      );
    default:
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg dark:bg-gray-500/10 bg-gray-100">
          <FileText className="size-5 dark:text-gray-400 text-gray-800" />
        </div>
      );
  }
}

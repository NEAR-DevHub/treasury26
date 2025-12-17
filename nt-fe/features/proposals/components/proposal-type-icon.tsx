import { ArrowLeftRight, FileText, Shield, Send, Coins, Download, Upload, Clock, CreditCard, TerminalSquare } from "lucide-react";
import { Proposal } from "@/lib/proposals-api";
import { getProposalType } from "../utils/proposal-utils";

interface ProposalTypeIconProps {
  proposal: Proposal;
  className?: string;
}

export function ProposalTypeIcon({ proposal, className = "h-5 w-5" }: ProposalTypeIconProps) {
  const type = getProposalType(proposal);

  switch (type) {
    case "Payment Request":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
          <CreditCard className={`${className} text-blue-300`} />
        </div>
      );
    case "Function Call":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
          <TerminalSquare className={`${className} text-blue-400`} />
        </div>
      );
    case "Change Policy":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10">
          <Shield className={`${className} text-amber-300`} />
        </div>
      );
    case "Vesting":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10">
          <Clock className={`${className} text-indigo-300`} />
        </div>
      );
    default:
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500/10">
          <FileText className={`${className} text-gray-600`} />
        </div>
      );
  }
}

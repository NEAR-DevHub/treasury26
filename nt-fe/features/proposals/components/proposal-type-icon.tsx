import { ArrowLeftRight, FileText, Shield, Send, Coins, Download, Upload, Clock } from "lucide-react";
import { Proposal } from "@/lib/proposals-api";
import { getProposalType } from "../utils/proposal-utils";

interface ProposalTypeIconProps {
  proposal: Proposal;
  className?: string;
}

export function ProposalTypeIcon({ proposal, className = "h-5 w-5" }: ProposalTypeIconProps) {
  const type = getProposalType(proposal);

  // Check description for specific action types
  const description = proposal.description.toLowerCase();

  if (description.includes("exchange") || description.includes("swap")) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10">
        <ArrowLeftRight className={`${className} text-purple-600`} />
      </div>
    );
  }

  if (description.includes("stake")) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10">
        <Upload className={`${className} text-green-600`} />
      </div>
    );
  }

  if (description.includes("unstake")) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10">
        <Download className={`${className} text-orange-600`} />
      </div>
    );
  }

  if (description.includes("withdraw")) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10">
        <Download className={`${className} text-cyan-600`} />
      </div>
    );
  }

  if (description.includes("vesting")) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10">
        <Clock className={`${className} text-indigo-600`} />
      </div>
    );
  }

  // Default icons based on type
  switch (type) {
    case "Payment Request":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
          <Send className={`${className} text-blue-600`} />
        </div>
      );
    case "Function Call":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
          <FileText className={`${className} text-blue-600`} />
        </div>
      );
    case "Change Policy":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10">
          <Shield className={`${className} text-amber-600`} />
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

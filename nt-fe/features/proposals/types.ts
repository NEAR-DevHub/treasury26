import { Proposal, ProposalKind } from "@/lib/proposals-api";

export type ProposalType = keyof ProposalKind | "Unsupported";

export interface ProposalTypeInfo {
  type: ProposalType;
  proposal: Proposal;
}

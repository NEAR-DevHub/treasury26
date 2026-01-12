import { VotePolicy } from "@/types/policy";
import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export type ProposalStatus =
  | "Approved"
  | "Rejected"
  | "InProgress"
  | "Expired"
  | "Removed"
  | "Moved"
  | "Failed";

export type Vote = "Approve" | "Reject" | "Remove";

export interface TransferKind {
  Transfer: {
    amount: string;
    msg: string | null;
    receiver_id: string;
    token_id: string;
  };
}

export interface FunctionCallAction {
  args: string;
  deposit: string;
  gas: string;
  method_name: string;
}

export interface FunctionCallKind {
  FunctionCall: {
    actions: FunctionCallAction[];
    receiver_id: string;
  };
}

export interface ChangePolicyKind {
  ChangePolicy: {
    policy: {
      bounty_bond: string;
      bounty_forgiveness_period: string;
      default_vote_policy: {
        quorum: string;
        threshold: [number, number] | string;
        weight_kind: string;
      };
      proposal_bond: string;
      proposal_period: string;
      roles: Array<{
        kind: {
          Group: string[];
        };
        name: string;
        permissions: string[];
        vote_policy: Record<string, {
          quorum: string;
          threshold: string | [number, number];
          weight_kind: string;
        }>;
      }>;
    };
  };
}

export interface ChangeConfigKind {
  ChangeConfig: {
    config: {
      metadata: string;
      purpose: string;
      name: string;
    }
  };
}

export interface ChangePolicyUpdateParametersKind {
  ChangePolicyUpdateParameters: {
    parameters: {
      bounty_bond: string | null;
      bounty_forgiveness_period: string | null;
      proposal_bond: string | null;
      proposal_period: string | null;
    };
  };
}

export interface AddMemberToRoleKind {
  AddMemberToRole: {
    member_id: string;
    role: string;
  };
}

export interface RemoveMemberFromRoleKind {
  RemoveMemberFromRole: {
    member_id: string;
    role: string;
  };
}

export interface UpgradeSelfKind {
  UpgradeSelf: {
    hash: string;
  };
}

export interface UpgradeRemoteKind {
  UpgradeRemote: {
    receiver_id: string;
    method_name: string;
    hash: string;
  };
}

export interface SetStakingContractKind {
  SetStakingContract: {
    staking_id: string;
  };
}

export interface Bounty {
  description: string;
  token: string;
  amount: string;
  times: number;
  max_deadline: string;
}

export interface AddBountyKind {
  AddBounty: {
    bounty: Bounty;
  };
}

export interface BountyDoneKind {
  BountyDone: {
    bounty_id: number;
    receiver_id: string;
  };
}

export interface VoteKind {
  Vote: {};
}

export interface FactoryInfo {
  factory_id: string;
  auto_update: boolean;
}

export interface FactoryInfoUpdateKind {
  FactoryInfoUpdate: {
    factory_info: FactoryInfo;
  };
}

export type RoleKind =
  | { Everyone: {} }
  | { Member: string }
  | { Group: string[] };

export type WeightKind = "TokenWeight" | "RoleWeight";

export type WeightOrRatio =
  | { Weight: string }
  | { Ratio: [number, number] };

export interface RolePermission {
  name: string;
  kind: RoleKind;
  permissions: string[];
  vote_policy: Record<string, VotePolicy>;
}

export interface ChangePolicyAddOrUpdateRoleKind {
  ChangePolicyAddOrUpdateRole: {
    role: RolePermission;
  };
}

export interface ChangePolicyRemoveRoleKind {
  ChangePolicyRemoveRole: {
    role: string;
  };
}

export interface ChangePolicyUpdateDefaultVotePolicyKind {
  ChangePolicyUpdateDefaultVotePolicy: {
    vote_policy: VotePolicy;
  };
}

export type ProposalKind =
  | TransferKind
  | FunctionCallKind
  | ChangePolicyKind
  | ChangePolicyUpdateParametersKind
  | ChangeConfigKind
  | AddMemberToRoleKind
  | RemoveMemberFromRoleKind
  | UpgradeSelfKind
  | UpgradeRemoteKind
  | SetStakingContractKind
  | AddBountyKind
  | BountyDoneKind
  | VoteKind
  | FactoryInfoUpdateKind
  | ChangePolicyAddOrUpdateRoleKind
  | ChangePolicyRemoveRoleKind
  | ChangePolicyUpdateDefaultVotePolicyKind;

export interface VoteCounts {
  [roleName: string]: [number, number, number];
}

export interface Proposal {
  description: string;
  id: number;
  kind: ProposalKind;
  last_actions_log: string | null;
  proposer: string;
  status: ProposalStatus;
  submission_time: string;
  vote_counts: VoteCounts;
  votes: {
    [account: string]: Vote;
  };
}

export interface ProposalsResponse {
  page: number;
  page_size: number;
  total: number;
  proposals: Proposal[];
}

export type StakeType = "stake" | "unstake" | "Withdraw Earnings" | "whitelist";

export type SourceType = "sputnikdao" | "intents" | "lockup";

export type SortBy = "CreationTime" | "ExpiryTime";

export type SortDirection = "asc" | "desc";

export interface ProposalFilters {
  // Status filters
  statuses?: ProposalStatus[];

  // Search filters
  search?: string;
  search_not?: string[];

  // Request type filters
  types?: string[];
  types_not?: string[];

  // User filters
  proposers?: string[];
  proposers_not?: string[];
  approvers?: string[];
  approvers_not?: string[];
  voter_votes?: string; // format: "account:vote,account:vote" where vote is "approved", "rejected", or "no_voted"

  // Payment-specific filters
  recipients?: string[];
  recipients_not?: string[];
  tokens?: string[];
  tokens_not?: string[];
  amount_min?: string;
  amount_max?: string;
  amount_equal?: string;

  // Stake delegation filters
  stake_type?: StakeType[];
  stake_type_not?: StakeType[];
  validators?: string[];
  validators_not?: string[];

  // Source filters
  source?: SourceType[];
  source_not?: SourceType[];

  // Date filters (YYYY-MM-DD format)
  created_date_from?: string;
  created_date_to?: string;
  created_date_from_not?: string;
  created_date_to_not?: string;

  // Pagination & sorting
  page?: number;
  page_size?: number;
  sort_by?: SortBy;
  sort_direction?: SortDirection;
}

/**
 * Get proposals for a specific DAO with optional filtering
 */
export async function getProposals(
  daoId: string,
  filters?: ProposalFilters
): Promise<ProposalsResponse> {
  if (!daoId) {
    return { page: 0, page_size: 0, total: 0, proposals: [] };
  }

  try {
    const url = `${BACKEND_API_BASE}/proposals/${daoId}`;

    // Build query parameters
    const params: Record<string, string> = {};

    if (filters) {
      // Array filters - join with commas
      if (filters.statuses) params.statuses = filters.statuses.join(',');
      if (filters.types) params.types = filters.types.join(',');
      if (filters.types_not) params.types_not = filters.types_not.join(',');
      if (filters.proposers) params.proposers = filters.proposers.join(',');
      if (filters.proposers_not) params.proposers_not = filters.proposers_not.join(',');
      if (filters.approvers) params.approvers = filters.approvers.join(',');
      if (filters.approvers_not) params.approvers_not = filters.approvers_not.join(',');
      if (filters.recipients) params.recipients = filters.recipients.join(',');
      if (filters.recipients_not) params.recipients_not = filters.recipients_not.join(',');
      if (filters.tokens) params.tokens = filters.tokens.join(',');
      if (filters.tokens_not) params.tokens_not = filters.tokens_not.join(',');
      if (filters.stake_type) params.stake_type = filters.stake_type.join(',');
      if (filters.stake_type_not) params.stake_type_not = filters.stake_type_not.join(',');
      if (filters.validators) params.validators = filters.validators.join(',');
      if (filters.validators_not) params.validators_not = filters.validators_not.join(',');
      if (filters.source) params.source = filters.source.join(',');
      if (filters.source_not) params.source_not = filters.source_not.join(',');
      if (filters.search_not) params.search_not = filters.search_not.join(',');

      // String filters
      if (filters.search) params.search = filters.search;
      if (filters.amount_min) params.amount_min = filters.amount_min;
      if (filters.amount_max) params.amount_max = filters.amount_max;
      if (filters.amount_equal) params.amount_equal = filters.amount_equal;
      if (filters.created_date_from) params.created_date_from = filters.created_date_from;
      if (filters.created_date_to) params.created_date_to = filters.created_date_to;
      if (filters.created_date_from_not) params.created_date_from_not = filters.created_date_from_not;
      if (filters.created_date_to_not) params.created_date_to_not = filters.created_date_to_not;
      if (filters.voter_votes) params.voter_votes = filters.voter_votes;

      // Pagination and sorting
      if (filters.page !== undefined) params.page = filters.page.toString();
      if (filters.page_size) params.page_size = filters.page_size.toString();
      if (filters.sort_by) params.sort_by = filters.sort_by;
      if (filters.sort_direction) params.sort_direction = filters.sort_direction;
    }

    const response = await axios.get<ProposalsResponse>(url, { params });

    return response.data;
  } catch (error) {
    console.error(`Error getting proposals for DAO ${daoId}`, error);
    return { page: 0, page_size: 0, total: 0, proposals: [] };
  }
}

export async function getProposal(daoId: string, proposalId: string): Promise<Proposal | null> {
  if (!daoId || !proposalId) {
    return null;
  }

  try {
    const url = `${BACKEND_API_BASE}/proposal/${daoId}/${proposalId}`;
    const response = await axios.get<Proposal>(url);
    return response.data;
  } catch (error) {
    console.error(`Error getting proposal for DAO ${daoId} and proposal ${proposalId}`, error);
    return null;
  }
}

export interface ProposersResponse {
  proposers: string[];
  total: number;
}

export interface ApproversResponse {
  approvers: string[];
  total: number;
}

/**
 * Get all unique proposers for a specific DAO
 */
export async function getDaoProposers(daoId: string): Promise<string[]> {
  if (!daoId) {
    return [];
  }

  try {
    const url = `${BACKEND_API_BASE}/proposals/${daoId}/proposers`;
    const response = await axios.get<ProposersResponse>(url);
    return response.data.proposers;
  } catch (error) {
    console.error(`Error getting proposers for DAO ${daoId}`, error);
    return [];
  }
}

/**
 * Get all unique approvers (voters) for a specific DAO
 */
export async function getDaoApprovers(daoId: string): Promise<string[]> {
  if (!daoId) {
    return [];
  }

  try {
    const url = `${BACKEND_API_BASE}/proposals/${daoId}/approvers`;
    const response = await axios.get<ApproversResponse>(url);
    return response.data.approvers;
  } catch (error) {
    console.error(`Error getting approvers for DAO ${daoId}`, error);
    return [];
  }
}

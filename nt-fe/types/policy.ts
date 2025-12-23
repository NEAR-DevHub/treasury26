/**
 * Treasury Policy Types
 * These types match the Rust types defined in nt-be/src/types/mod.rs
 */

export type RoleKind =
  | "Everyone"
  | { Member: string } // NearToken as string
  | { Group: string[] }; // Set of AccountIds

export interface RolePermission {
  /** Name of the role to display to the user */
  name: string;
  /** Kind of the role: defines which users this permissions apply */
  kind: RoleKind;
  /** Set of actions on which proposals that this role is allowed to execute */
  permissions: string[];
  /** For each proposal kind, defines voting policy */
  vote_policy: Record<string, VotePolicy>;
}

export interface UserInfo {
  account_id: string;
  amount: string; // NearToken as string
}

export type WeightOrRatio =
  | string // U128 as string
  | [number, number]; // (numerator, denominator)

export type WeightKind = "TokenWeight" | "RoleWeight";

export interface VotePolicy {
  /** Kind of weight to use for votes */
  weight_kind: WeightKind;
  /** Minimum number required for vote to finalize */
  quorum: string; // U128 as string
  /** How many votes to pass this vote */
  threshold: WeightOrRatio;
}

export interface Policy {
  /** List of roles and permissions for them in the current policy */
  roles: RolePermission[];
  /** Default vote policy. Used when given proposal kind doesn't have special policy */
  default_vote_policy: VotePolicy;
  /** Proposal bond */
  proposal_bond: string; // NearToken as string
  /** Expiration period for proposals */
  proposal_period: string; // U64 as string
  /** Bond for claiming a bounty */
  bounty_bond: string; // NearToken as string
  /** Period in which giving up on bounty is not punished */
  bounty_forgiveness_period: string; // U64 as string
}

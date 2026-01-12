import { ProposalFilters } from "@/lib/proposals-api";
import { parseFilterData } from "../types/filter-types";

/**
 * Converts URL search params (which contain JSON-encoded filter data)
 * to the backend API ProposalFilters format
 * @param searchParams - URL search parameters containing filter data
 * @param userId - Optional user ID for voter-specific filters (my_vote)
 */
export function convertUrlParamsToApiFilters(
  searchParams: URLSearchParams,
  userId?: string | null
): Partial<ProposalFilters> {
  const filters: Partial<ProposalFilters> = {};

  // Handle proposers filter
  const proposersParam = searchParams.get("proposers");
  if (proposersParam) {
    const proposersData = parseFilterData(proposersParam) as { operation: string; users: string[] } | null;
    if (proposersData?.users && proposersData.users.length > 0) {
      if (proposersData.operation === "Is") {
        filters.proposers = proposersData.users;
      } else if (proposersData.operation === "Is Not") {
        filters.proposers_not = proposersData.users;
      }
    }
  }

  // Handle approvers filter
  const approversParam = searchParams.get("approvers");
  if (approversParam) {
    const approversData = parseFilterData(approversParam) as { operation: string; users: string[] } | null;
    if (approversData?.users && approversData.users.length > 0) {
      if (approversData.operation === "Is") {
        filters.approvers = approversData.users;
      } else if (approversData.operation === "Is Not") {
        filters.approvers_not = approversData.users;
      }
    }
  }

  // Handle recipients filter
  const recipientsParam = searchParams.get("recipients");
  if (recipientsParam) {
    const recipientsData = parseFilterData(recipientsParam) as { operation: string; users: string[] } | null;
    if (recipientsData?.users && recipientsData.users.length > 0) {
      if (recipientsData.operation === "Is") {
        filters.recipients = recipientsData.users;
      } else if (recipientsData.operation === "Is Not") {
        filters.recipients_not = recipientsData.users;
      }
    }
  }

  // Handle proposal_types filter
  const proposalTypesParam = searchParams.get("proposal_types");
  if (proposalTypesParam) {
    const proposalTypesData = parseFilterData(proposalTypesParam) as { operation: string; selected: string[] } | null;
    if (proposalTypesData?.selected && proposalTypesData.selected.length > 0) {
      // Map frontend names to backend names
      const backendTypes = proposalTypesData.selected.map(type => {
        switch (type) {
          case "Payments": return "Payments";
          case "Exchange": return "Exchange";
          case "Earn": return "Earn";
          case "Vesting": return "Vesting";
          case "Change Policy": return "Change Policy";
          case "Settings": return "Settings";
          default: return type;
        }
      });

      if (proposalTypesData.operation === "Is") {
        filters.types = backendTypes;
      }
      if (proposalTypesData.operation === "Is Not") {
        filters.types_not = backendTypes;
      }
    }
  }

  // Handle tokens filter
  const tokensParam = searchParams.get("tokens");
  if (tokensParam) {
    const tokensData = parseFilterData(tokensParam) as {
      operation: string;
      token: { id: string; symbol: string };
      amountOperation?: string;
      minAmount?: string;
      maxAmount?: string;
    } | null;

    if (tokensData?.token) {
      const tokenId = tokensData.token.symbol;

      if (tokensData.operation === "Is") {
        filters.tokens = [tokenId];

        // Handle amount filters
        if (tokensData.amountOperation && (tokensData.minAmount || tokensData.maxAmount)) {
          switch (tokensData.amountOperation) {
            case "Between":
              if (tokensData.minAmount) filters.amount_min = tokensData.minAmount;
              if (tokensData.maxAmount) filters.amount_max = tokensData.maxAmount;
              break;
            case "Equal":
              if (tokensData.minAmount) filters.amount_equal = tokensData.minAmount;
              break;
            case "More Than":
              if (tokensData.minAmount) filters.amount_min = tokensData.minAmount;
              break;
            case "Less Than":
              if (tokensData.minAmount) filters.amount_max = tokensData.minAmount;
              break;
          }
        }
      } else if (tokensData.operation === "Is Not") {
        filters.tokens_not = [tokenId];
      }
    }
  }

  // Handle created_date filter
  const createdDateParam = searchParams.get("created_date");
  if (createdDateParam) {
    const dateData = parseFilterData(createdDateParam) as { operation: string; date: string } | null;
    if (dateData?.date) {
      const date = new Date(dateData.date);
      const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format

      switch (dateData.operation) {
        case "Is":
          // For "Is", set both from and to to the same date
          filters.created_date_from = dateString;
          filters.created_date_to = dateString;
          break;
        case "Before":
          filters.created_date_to = dateString;
          break;
        case "After":
          filters.created_date_from = dateString;
          break;
        case "Is Not":
          filters.created_date_from_not = dateString;
          filters.created_date_to_not = dateString;
          break;
      }
    }
  }

  const myVoteParam = searchParams.get("my_vote");
  if (myVoteParam && userId) {
    const myVoteData = parseFilterData(myVoteParam) as { operation: string; selected: string[] } | null;
    if (myVoteData?.selected && myVoteData.selected.length > 0) {
      const voteString = `${userId}:${myVoteData.selected.join(',')}`;
      filters.voter_votes = voteString;
    }
  }

  return filters;
}

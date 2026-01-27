import { IntentsQuoteResponse } from "@/lib/api";
import { Token } from "@/components/token-input";
import { encodeToMarkdown } from "@/lib/utils";

interface ProposalBuilderParams {
  proposalData: IntentsQuoteResponse;
  sellToken: Token;
  receiveToken: Token;
  slippageTolerance: number;
  treasuryId: string;
  proposalBond: string;
}

interface ProposalAction {
  method_name: string;
  args: string;
  deposit: string;
  gas: string;
}

interface ProposalResult {
  description: string;
  kind: {
    FunctionCall: {
      receiver_id: string;
      actions: ProposalAction[];
    };
  };
}

/**
 * Builds a proposal description with encoded metadata
 */
export function buildProposalDescription(
  proposalData: IntentsQuoteResponse,
  sellToken: Token,
  receiveToken: Token,
  slippageTolerance: number,
  memo?: string
): string {
  return encodeToMarkdown({
    proposal_action: "asset-exchange",
    notes: `**Must be executed before ${proposalData.timestamp}** for transferring tokens to 1Click's deposit address for swap execution.`,
    tokenIn: sellToken.symbol,
    tokenOut: receiveToken.symbol,
    amountIn: proposalData.quote.amountInFormatted,
    amountOut: proposalData.quote.amountOutFormatted,
    slippage: slippageTolerance.toString(),
    quoteDeadline: proposalData.timestamp,
    destinationNetwork: receiveToken.network,
    timeEstimate: proposalData.quote.timeEstimate
      ? `${proposalData.quote.timeEstimate} seconds`
      : undefined,
    depositAddress: proposalData.quote.depositAddress,
    signature: proposalData.signature,
  });
}

/**
 * Builds the proposal structure for native NEAR swaps
 */
export function buildNativeNEARProposal(params: ProposalBuilderParams): ProposalResult {
  const { proposalData, sellToken, receiveToken, slippageTolerance } = params;
  const amountInSmallestUnit = proposalData.quote.amountIn;
  const originAsset = "wrap.near";

  return {
    description: buildProposalDescription(
      proposalData,
      sellToken,
      receiveToken,
      slippageTolerance
    ),
    kind: {
      FunctionCall: {
        receiver_id: "wrap.near",
        actions: [
          {
            method_name: "near_deposit",
            args: Buffer.from(JSON.stringify({})).toString("base64"),
            deposit: amountInSmallestUnit,
            gas: "10000000000000", // 10 TGas
          },
          {
            method_name: "ft_transfer_call",
            args: Buffer.from(
              JSON.stringify({
                receiver_id: "intents.near",
                amount: amountInSmallestUnit,
                msg: JSON.stringify({
                  receiver_id: proposalData.quote.depositAddress,
                  token_id: originAsset,
                }),
              })
            ).toString("base64"),
            deposit: "1", // 1 yoctoNEAR for storage
            gas: "150000000000000", // 150 TGas
          },
        ],
      },
    },
  };
}

/**
 * Builds the proposal structure for fungible token swaps
 * - For FT tokens (network === "near"): Use ft_transfer_call on the token contract
 * - For Intents tokens (network !== "near"): Use mt_transfer on intents.near
 */
export function buildFungibleTokenProposal(params: ProposalBuilderParams): ProposalResult {
  const { proposalData, sellToken, receiveToken, slippageTolerance } = params;
  const amountInSmallestUnit = proposalData.quote.amountIn;
  const originAsset = sellToken.address;
  const isNearToken = sellToken.network === "near" && !sellToken.address.startsWith("nep141:");

  if (isNearToken) {
    // For NEAR FT tokens, use ft_transfer_call on the token contract
    return {
      description: buildProposalDescription(
        proposalData,
        sellToken,
        receiveToken,
        slippageTolerance
      ),
      kind: {
        FunctionCall: {
          receiver_id: sellToken.address, // Call the token contract directly
          actions: [
            {
              method_name: "ft_transfer_call",
              args: Buffer.from(
                JSON.stringify({
                  receiver_id: "intents.near",
                  amount: amountInSmallestUnit,
                  msg: JSON.stringify({
                    receiver_id: proposalData.quote.depositAddress,
                  }),
                })
              ).toString("base64"),
              deposit: "1", // 1 yoctoNEAR for storage
              gas: "150000000000000", // 150 TGas
            },
          ],
        },
      },
    };
  } else {
    // For intents tokens, use mt_transfer on intents.near
    return {
      description: buildProposalDescription(
        proposalData,
        sellToken,
        receiveToken,
        slippageTolerance
      ),
      kind: {
        FunctionCall: {
          receiver_id: "intents.near",
          actions: [
            {
              method_name: "mt_transfer",
              args: Buffer.from(
                JSON.stringify({
                  receiver_id: proposalData.quote.depositAddress,
                  amount: amountInSmallestUnit,
                  token_id: originAsset,
                })
              ).toString("base64"),
              deposit: "1", // 1 yoctoNEAR
              gas: "150000000000000", // 150 TGas
            },
          ],
        },
      },
    };
  }
}


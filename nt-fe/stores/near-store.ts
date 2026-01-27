"use client";

import { create } from "zustand";
import {
  NearConnector,
  SignAndSendTransactionsParams,
  SignedMessage,
  ConnectorAction,
} from "@hot-labs/near-connect";
import { NEAR_TREASURY_CONFIG } from "@/constants/config";
import {
  EventMap,
  FinalExecutionOutcome,
} from "@hot-labs/near-connect/build/types";
import { Vote as ProposalVote, getProposal } from "@/lib/proposals-api";
import { ProposalPermissionKind } from "@/lib/config-utils";
import { toast } from "sonner";
import Big from "big.js";
import { useQueryClient } from "@tanstack/react-query";
import { payoutBatch } from "@/lib/bulk-payment-api";

export interface CreateProposalParams {
  treasuryId: string;
  proposal: {
    description: string;
    kind: any;
  };
  proposalBond: string;
  additionalTransactions?: Array<{
    receiverId: string;
    actions: ConnectorAction[];
  }>;
}

interface Vote {
  proposalId: number;
  vote: ProposalVote;
  proposalKind: ProposalPermissionKind;
}

interface NearStore {
  connector: NearConnector | null;
  accountId: string | null;
  isInitializing: boolean;
  init: () => Promise<NearConnector | undefined>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (
    message: string
  ) => Promise<{ signatureData: SignedMessage; signedData: string }>;
  signAndSendTransactions: (
    params: SignAndSendTransactionsParams
  ) => Promise<Array<FinalExecutionOutcome>>;
  createProposal: (
    toastMessage: string,
    params: CreateProposalParams,
    showToast?: boolean
  ) => Promise<Array<FinalExecutionOutcome>>;
  voteProposals: (
    treasuryId: string,
    votes: Vote[]
  ) => Promise<Array<FinalExecutionOutcome>>;
}

export const useNearStore = create<NearStore>((set, get) => ({
  connector: null,
  accountId: null,
  isInitializing: true,

  init: async () => {
    const { connector } = get();

    if (connector) {
      return connector;
    }

    let newConnector = null;

    try {
      newConnector = new NearConnector({
        network: "mainnet",
      });
    } catch (err) {
      set({ isInitializing: false });
      return;
    }

    newConnector.on("wallet:signOut", () => set({ accountId: null }));
    newConnector.on(
      "wallet:signIn",
      ({ accounts }: EventMap["wallet:signIn"]) => {
        set({ accountId: accounts[0]?.accountId });
      }
    );

    set({ connector: newConnector });

    try {
      const wallet = await newConnector.wallet();
      const accounts = await wallet.getAccounts();
      const accountId = accounts[0]?.accountId;
      if (accountId) {
        set({ accountId });
      }
    } catch { } // No existing wallet connection found

    set({ isInitializing: false });
    return newConnector;
  },

  connect: async () => {
    const { connector, init } = get();
    const newConnector = connector ?? (await init());
    if (newConnector) {
      await newConnector.connect();
    }
  },

  disconnect: async () => {
    const { connector } = get();
    if (!connector) return;
    await connector.disconnect();
  },

  signMessage: async (message: string) => {
    const { connector } = get();
    if (!connector) {
      throw new Error("Connector not initialized");
    }
    const wallet = await connector.wallet();
    const signatureData = await wallet.signMessage({
      message,
      recipient: "",
      nonce: new Uint8Array(),
    });
    return { signatureData, signedData: message };
  },

  signAndSendTransactions: async (params: SignAndSendTransactionsParams) => {
    const { connector } = get();
    if (!connector) {
      throw new Error("Connector not initialized");
    }
    const wallet = await connector.wallet();
    return wallet.signAndSendTransactions(params);
  },

  createProposal: async (
    toastMessage: string,
    params: CreateProposalParams,
    showToast: boolean = true
  ) => {
    const { connector } = get();
    if (!connector) {
      throw new Error("Connector not initialized");
    }

    const gas = "270000000000000";

    const proposalTransaction = {
      receiverId: params.treasuryId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "add_proposal",
            args: {
              proposal: params.proposal,
            },
            gas,
            deposit: params.proposalBond,
          },
        } as ConnectorAction,
      ],
    };

    const transactions = [
      proposalTransaction,
      ...(params.additionalTransactions || []),
    ];
    try {
      const wallet = await connector.wallet();
      const results = await wallet.signAndSendTransactions({
        transactions,
        network: "mainnet",
      });
      if (showToast) {
      toast.success(toastMessage, {
        duration: 10000, // 10 seconds
        action: {
          label: "View Request",
          onClick: () =>
            window.open(`/${params.treasuryId}/requests?tab=pending`),
        },
        classNames: {
          toast: "!p-2 !px-4",
          actionButton:
            "!bg-transparent !text-foreground hover:!bg-muted !border-0",
          title: "!border-r !border-r-border !pr-4",
        },
      });
      }
      return results;
    } catch (error) {
      console.error("Failed to create proposal:", error);
      toast.error("Failed to create proposal");
      return [];
    }
  },

  voteProposals: async (treasuryId: string, votes: Vote[]) => {
    const { signAndSendTransactions } = get();
    const gas = Big("300000000000000").div(votes.length).toFixed();
    try {
      const results = await signAndSendTransactions({
        transactions: [
          {
            receiverId: treasuryId,
            actions: [
              ...votes.map((vote) => ({
                type: "FunctionCall",
                params: {
                  methodName: "act_proposal",
                  args: {
                    id: vote.proposalId,
                    action: `Vote${vote.vote}`,
                    proposal: vote.proposalKind,
                  },
                  gas: gas.toString(),
                  deposit: "0",
                },
              })),
            ],
          },
        ],
      });
      return results;
    } catch (error) {
      console.error("Failed to vote proposals:", error);
      toast.error(`Failed to submit vote${votes.length > 1 ? "s" : ""}`);
      return [];
    }
  },
}));

// Convenience hook matching your existing API
export const useNear = () => {
  const {
    connector,
    accountId,
    isInitializing,
    connect,
    disconnect,
    signMessage,
    signAndSendTransactions,
    createProposal: storeCreateProposal,
    voteProposals: storeVoteProposals,
  } = useNearStore();

  const queryClient = useQueryClient();

  const createProposal = async (
    toastMessage: string,
    params: CreateProposalParams,
    showToast: boolean = true
  ) => {
    const results = await storeCreateProposal(toastMessage, params, showToast);
    if (results.length > 0) {
      // Delay to allow backend to pick up the new proposal
      await new Promise((resolve) => setTimeout(resolve, 5000));
      // Invalidate and refetch proposals
      await queryClient.invalidateQueries({
        queryKey: ["proposals", params.treasuryId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["proposal", params.treasuryId],
      });
    }
    return results;
  };

  const voteProposals = async (treasuryId: string, votes: Vote[]) => {
    const results = await storeVoteProposals(treasuryId, votes);
    if (results.length > 0) {
      // Delay to allow backend to pick up the new votes
      await new Promise((resolve) => setTimeout(resolve, 5000));
      let promises = [];
      // Invalidate proposals list
      promises.push(queryClient.invalidateQueries({
        queryKey: ["proposals", treasuryId],
      }));
      // Invalidate individual proposal queries for the voted proposals
      promises.push(...
        votes.map((vote) =>
          queryClient.invalidateQueries({
            queryKey: ["proposal", treasuryId, vote.proposalId.toString()],
          }))
      );
      promises.push(...
        votes.map((vote) =>
          queryClient.invalidateQueries({
            queryKey: ["proposal-transaction", treasuryId, vote.proposalId.toString()],
          }))
      );
      await Promise.all(promises);

      // Wait a bit for queries to refetch before checking proposal status
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if any approved proposals are bulk payments
      let hasBulkPayment = false;
      
      for (const vote of votes) {
        if (vote.vote === "Approve") {
          try {

            const proposal = await getProposal(treasuryId, vote.proposalId.toString());
                        
            if (!proposal) {
              continue;
            }
            
            // Check if proposal is approved
            console.log(`Proposal ${vote.proposalId} status:`, proposal.status);
            if (proposal.status === "Approved") {
              // Check if it's a bulk payment proposal by looking at description
              // Match various formats: "list_id:", "List Id:", "listId:", etc.
              const descMatch = proposal.description.match(/list[\s_]*id["\s:]+([a-f0-9]{64})/i);
              console.log(`Proposal ${vote.proposalId} description match:`, descMatch);
              if (descMatch && descMatch[1]) {
                const listId = descMatch[1];
                hasBulkPayment = true;
                console.log(`Detected approved bulk payment proposal ${vote.proposalId}, triggering payout for list ${listId}`);
                
                // Show processing toast
                const processingToastId = toast.loading(
                  "Processing bulk payments...",
                  {
                    duration: Infinity, // Keep showing until we dismiss it
                  }
                );
                
                // Trigger payout batch
                try {
                  const result = await payoutBatch(listId);
                  console.log(`Payout completed for list ${listId}:`, result);
                  
                  // Dismiss processing toast
                  toast.dismiss(processingToastId);
                  
                  // Show success toast
                  toast.success(
                    `Bulk payment executed`,
                    {
                      duration: 5000,
                    }
                  );
                } catch (error: any) {
                  console.error(`Failed to execute payout for list ${listId}:`, error);
                  
                  // Dismiss processing toast
                  toast.dismiss(processingToastId);
                  
                  // Show error toast
                  toast.error(`Failed to execute bulk payment: ${error.message}`);
                }
              } else {
                console.log(`Proposal ${vote.proposalId} is not a bulk payment (no list_id in description)`);
              }
            } else {
              console.log(`Proposal ${vote.proposalId} is not yet approved, status is: ${proposal.status}`);
            }
          } catch (error) {
            console.error(`Failed to check proposal ${vote.proposalId} for bulk payment:`, error);
          }
        }
      }
      
      // Show success toast for regular votes (non-bulk payments)
      if (!hasBulkPayment) {
        toast.success(
          `Your vote${votes.length > 1 ? "s" : ""} have been submitted`
        );
      }

      // Invalidate policy and config since voting can approve proposals that change them
      await queryClient.invalidateQueries({
        queryKey: ["treasuryPolicy", treasuryId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["treasuryConfig", treasuryId],
      });
      // Invalidate user treasuries to update sidebar name/logo
      await queryClient.invalidateQueries({
        queryKey: ["userTreasuries", accountId],
      });
    }
    return results;
  };

  return {
    connector,
    accountId,
    isInitializing,
    connect,
    disconnect,
    signMessage,
    signAndSendTransactions,
    createProposal,
    voteProposals,
  };
};

"use client";

import { create } from "zustand";
import { NearConnector, SignAndSendTransactionsParams, SignedMessage, ConnectorAction } from "@hot-labs/near-connect";
import { NEAR_TREASURY_CONFIG } from "@/constants/config";
import { EventMap, FinalExecutionOutcome } from "@hot-labs/near-connect/build/types";
import { Vote as ProposalVote } from "@/lib/proposals-api";
import { ProposalPermissionKind } from "@/lib/config-utils";
import { toast } from "sonner";
import Big from "big.js";
import { useQueryClient } from "@tanstack/react-query";

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
    signMessage: (message: string) => Promise<{ signatureData: SignedMessage; signedData: string }>;
    signAndSendTransactions: (params: SignAndSendTransactionsParams) => Promise<Array<FinalExecutionOutcome>>;
    createProposal: (toastMessage: string, params: CreateProposalParams) => Promise<Array<FinalExecutionOutcome>>;
    voteProposals: (treasuryId: string, votes: Vote[]) => Promise<Array<FinalExecutionOutcome>>;
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
                walletConnect: {
                    projectId: "near-treasury",
                    metadata: {
                        name: NEAR_TREASURY_CONFIG.brandName,
                        description: NEAR_TREASURY_CONFIG.brandDescription,
                        url: NEAR_TREASURY_CONFIG.brandUrl,
                        icons: [NEAR_TREASURY_CONFIG.brandLogo],
                    },
                },
            });
        } catch (err) {
            set({ isInitializing: false });
            return;
        }

        newConnector.on("wallet:signOut", () => set({ accountId: null }));
        newConnector.on("wallet:signIn", ({ accounts }: EventMap["wallet:signIn"]) => {
            set({ accountId: accounts[0]?.accountId });
        });

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
        const signatureData = await wallet.signMessage({ message, recipient: "", nonce: new Uint8Array() });
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

    createProposal: async (toastMessage: string, params: CreateProposalParams) => {
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
            toast.success(toastMessage, {
                action: {
                    label: "View Request",
                    onClick: () => window.open(`/${params.treasuryId}/requests?tab=pending`),
                },
            });
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
                            ...votes.map(vote => ({
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
            toast.success(`Successfully voted on ${votes.length} proposal${votes.length > 1 ? "s" : ""}`);
            return results;
        } catch (error) {
            console.error("Failed to vote proposals:", error);
            toast.error(`Failed to vote proposal${votes.length > 1 ? "s" : ""}`);
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

    const createProposal = async (toastMessage: string, params: CreateProposalParams) => {
        const results = await storeCreateProposal(toastMessage, params);
        if (results.length > 0) {
            // Invalidate both proposals list and individual proposal queries
            await queryClient.invalidateQueries({ queryKey: ["proposals", params.treasuryId] });
            await queryClient.invalidateQueries({ queryKey: ["proposal", params.treasuryId] });
        }
        return results;
    };

    const voteProposals = async (treasuryId: string, votes: Vote[]) => {
        const results = await storeVoteProposals(treasuryId, votes);
        if (results.length > 0) {
            // Invalidate proposals list
            await queryClient.invalidateQueries({ queryKey: ["proposals", treasuryId] });
            // Invalidate individual proposal queries for the voted proposals
            await Promise.all(
                votes.map(vote =>
                    queryClient.invalidateQueries({ queryKey: ["proposal", treasuryId, vote.proposalId.toString()] })
                )
            );
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

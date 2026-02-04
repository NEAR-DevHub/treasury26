"use client";

import { create } from "zustand";
import {
    NearConnector,
    SignAndSendTransactionsParams,
    SignedMessage,
    ConnectorAction,
} from "@hot-labs/near-connect";
import {
    EventMap,
    FinalExecutionOutcome,
} from "@hot-labs/near-connect/build/types";
import { Vote as ProposalVote } from "@/lib/proposals-api";
import { ProposalPermissionKind } from "@/lib/config-utils";
import { toast } from "sonner";
import Big from "big.js";
import { useQueryClient } from "@tanstack/react-query";
import { ledgerWalletManifest } from "@/lib/ledger-manifest";
import {
    getAuthChallenge,
    authLogin,
    acceptTerms as apiAcceptTerms,
    getAuthMe,
    authLogout,
    AuthUserInfo,
} from "@/lib/auth-api";
import { markDaoDirty } from "@/lib/api";

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
    // Wallet state
    connector: NearConnector | null;
    walletAccountId: string | null; // Raw wallet account ID
    isInitializing: boolean;

    // Auth state
    isAuthenticated: boolean;
    hasAcceptedTerms: boolean;
    isAuthenticating: boolean;
    authError: string | null;
    user: AuthUserInfo | null;

    // Wallet actions
    init: () => Promise<NearConnector | undefined>;
    connect: () => Promise<boolean>;
    disconnect: () => Promise<void>;

    // Auth actions
    acceptTerms: () => Promise<void>;
    checkAuth: () => Promise<void>;
    clearError: () => void;

    // Transaction actions (require full auth)
    signMessage: (
        message: string,
    ) => Promise<{ signatureData: SignedMessage; signedData: string }>;
    signAndSendTransactions: (
        params: SignAndSendTransactionsParams,
    ) => Promise<Array<FinalExecutionOutcome>>;
    createProposal: (
        toastMessage: string,
        params: CreateProposalParams,
        showToast: boolean,
    ) => Promise<Array<FinalExecutionOutcome>>;
    voteProposals: (
        treasuryId: string,
        votes: Vote[],
    ) => Promise<Array<FinalExecutionOutcome>>;
}

// Helper to check if fully authenticated
const isFullyAuthenticated = (state: NearStore): boolean => {
    return (
        state.isAuthenticated &&
        state.hasAcceptedTerms &&
        !!state.walletAccountId
    );
};

export const useNearStore = create<NearStore>((set, get) => ({
    // Wallet state
    connector: null,
    walletAccountId: null,
    isInitializing: true,

    // Auth state
    isAuthenticated: false,
    hasAcceptedTerms: false,
    isAuthenticating: false,
    authError: null,
    user: null,

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

        // Handle wallet sign out - reset all auth state
        newConnector.on("wallet:signOut", () => {
            set({
                walletAccountId: null,
                isAuthenticated: false,
                hasAcceptedTerms: false,
                user: null,
                authError: null,
            });
        });

        newConnector.on(
            "wallet:signIn",
            ({ accounts }: EventMap["wallet:signIn"]) => {
                set({ walletAccountId: accounts[0]?.accountId ?? null });
            },
        );

        set({ connector: newConnector });

        // Register Ledger wallet after connector is initialized
        newConnector.whenManifestLoaded.then(async () => {
            // Check if WebHID is supported (not on mobile, requires secure context)
            if (typeof navigator !== "undefined" && "hid" in navigator) {
                try {
                    await newConnector.registerWallet(ledgerWalletManifest);
                    console.log("Ledger wallet registered successfully");
                } catch (e) {
                    console.warn("Failed to register Ledger wallet:", e);
                }
            }
        });

        try {
            const wallet = await newConnector.wallet();
            const accounts = await wallet.getAccounts();
            const accountId = accounts[0]?.accountId;
            if (accountId) {
                set({ walletAccountId: accountId });
            }
        } catch (e) {
            // Silently handle errors - common cases:
            // - No existing wallet connection found
            // - Ledger wallet requires user gesture to reconnect (WebHID restriction)
            if (e instanceof Error && e.message.includes("user gesture")) {
                console.log("Ledger requires user interaction to reconnect");
            }
        }

        set({ isInitializing: false });
        return newConnector;
    },

    connect: async () => {
        const { connector, init } = get();
        const newConnector = connector ?? (await init());
        if (!newConnector) {
            return false;
        }

        set({ isAuthenticating: true, authError: null });

        try {
            // Connect wallet first
            await newConnector.connect();

            // Get the account ID after connection
            const wallet = await newConnector.wallet();
            const accounts = await wallet.getAccounts();
            const accountId = accounts[0]?.accountId;

            if (!accountId) {
                set({ isAuthenticating: false });
                return false;
            }

            set({ walletAccountId: accountId });

            // Get challenge from backend
            const { nonce } = await getAuthChallenge(accountId);

            // Decode base64 nonce to Uint8Array
            const nonceBytes = Uint8Array.from(atob(nonce), (c) =>
                c.charCodeAt(0),
            );

            // Sign the message with wallet
            const message = "Login to Trezu";
            const recipient = "Trezu App";

            const signedMessage = await wallet.signMessage({
                message,
                recipient,
                nonce: nonceBytes,
            });

            // Send signature to backend for verification
            const loginResponse = await authLogin({
                account_id: accountId,
                public_key: signedMessage.publicKey,
                signature: signedMessage.signature,
                message,
                nonce,
                recipient,
            });

            set({
                isAuthenticated: true,
                hasAcceptedTerms: loginResponse.terms_accepted,
                user: {
                    account_id: loginResponse.account_id,
                    terms_accepted: loginResponse.terms_accepted,
                },
                isAuthenticating: false,
            });

            return true;
        } catch (error) {
            console.error("Authentication failed:", error);
            set({
                isAuthenticating: false,
                authError:
                    error instanceof Error
                        ? error.message
                        : "Authentication failed",
            });
            return false;
        }
    },

    disconnect: async () => {
        const { connector } = get();

        // Logout from backend first
        try {
            await authLogout();
        } catch (error) {
            console.error("Logout error:", error);
        }

        // Reset auth state
        set({
            isAuthenticated: false,
            hasAcceptedTerms: false,
            user: null,
            authError: null,
        });

        // Disconnect wallet
        if (connector) {
            await connector.disconnect();
        }
    },

    acceptTerms: async () => {
        try {
            await apiAcceptTerms();
            set({ hasAcceptedTerms: true });
            const user = get().user;
            if (user) {
                set({
                    user: {
                        ...user,
                        terms_accepted: true,
                    },
                });
            }
        } catch (error) {
            console.error("Failed to accept terms:", error);
            throw error;
        }
    },

    checkAuth: async () => {
        try {
            const user = await getAuthMe();
            if (user) {
                set({
                    isAuthenticated: true,
                    hasAcceptedTerms: user.terms_accepted,
                    user,
                });
            } else {
                set({
                    isAuthenticated: false,
                    hasAcceptedTerms: false,
                    user: null,
                });
            }
        } catch (error) {
            set({
                isAuthenticated: false,
                hasAcceptedTerms: false,
                user: null,
            });
        }
    },

    clearError: () => {
        set({ authError: null });
    },

    signMessage: async (message: string) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            throw new Error(
                "Not authorized. Please connect wallet and accept terms.",
            );
        }
        if (!state.connector) {
            throw new Error("Connector not initialized");
        }
        const wallet = await state.connector.wallet();
        const signatureData = await wallet.signMessage({
            message,
            recipient: "",
            nonce: new Uint8Array(),
        });
        return { signatureData, signedData: message };
    },

    signAndSendTransactions: async (params: SignAndSendTransactionsParams) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            throw new Error(
                "Not authorized. Please connect wallet and accept terms.",
            );
        }
        if (!state.connector) {
            throw new Error("Connector not initialized");
        }
        const wallet = await state.connector.wallet();
        return wallet.signAndSendTransactions(params);
    },

    createProposal: async (
        toastMessage: string,
        params: CreateProposalParams,
        showToast: boolean = true,
    ) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            toast.error("Please connect wallet and accept terms to continue.");
            return [];
        }
        if (!state.connector) {
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
            const wallet = await state.connector.wallet();
            const results = await wallet.signAndSendTransactions({
                transactions,
                network: "mainnet",
            });
            if (showToast) {
                toast.success(toastMessage, {
                    duration: 10000,
                    action: {
                        label: "View Request",
                        onClick: () =>
                            window.open(
                                `/${params.treasuryId}/requests?tab=pending`,
                            ),
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
            toast.error("Transaction wasn't approved in your wallet.");
            return [];
        }
    },

    voteProposals: async (treasuryId: string, votes: Vote[]) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            toast.error("Please connect wallet and accept terms to continue.");
            return [];
        }

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
            toast.success(
                `Your vote${votes.length > 1 ? "s" : ""} have been submitted`,
            );
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
        walletAccountId,
        isInitializing,
        isAuthenticated,
        hasAcceptedTerms,
        isAuthenticating,
        authError,
        user,
        connect,
        disconnect,
        acceptTerms,
        checkAuth,
        clearError,
        signMessage,
        signAndSendTransactions,
        createProposal: storeCreateProposal,
        voteProposals: storeVoteProposals,
    } = useNearStore();

    const queryClient = useQueryClient();

    // accountId is only available when fully authenticated (connected + auth + terms accepted)
    const accountId =
        isAuthenticated && hasAcceptedTerms ? walletAccountId : null;
    const createProposal = async (
        toastMessage: string,
        params: CreateProposalParams,
        showToast: boolean = true,
    ) => {
        const results = await storeCreateProposal(
            toastMessage,
            params,
            showToast,
        );

        // If successful, invalidate queries after delay in background
        if (results.length > 0) {
            (async () => {
                // Delay to allow backend to pick up the new proposal
                await new Promise((resolve) => setTimeout(resolve, 5000));
                // Invalidate and refetch proposals
                await queryClient.invalidateQueries({
                    queryKey: ["proposals", params.treasuryId],
                });
                await queryClient.invalidateQueries({
                    queryKey: ["proposal", params.treasuryId],
                });
            })();
        } else {
            throw new Error("Transaction wasn't approved in your wallet.");
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
            promises.push(
                queryClient.invalidateQueries({
                    queryKey: ["proposals", treasuryId],
                }),
            );
            // Invalidate individual proposal queries for the voted proposals
            promises.push(
                ...votes.map((vote) =>
                    queryClient.invalidateQueries({
                        queryKey: [
                            "proposal",
                            treasuryId,
                            vote.proposalId.toString(),
                        ],
                    }),
                ),
            );
            promises.push(
                ...votes.map((vote) =>
                    queryClient.invalidateQueries({
                        queryKey: [
                            "proposal-transaction",
                            treasuryId,
                            vote.proposalId.toString(),
                        ],
                    }),
                ),
            );
            await Promise.all(promises);

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

            // Mark DAO as dirty if voting on policy-related proposals
            // This triggers immediate re-sync of membership data
            const policyKinds: ProposalPermissionKind[] = [
                "policy",
                "add_member_to_role",
                "remove_member_from_role",
            ];
            const hasPolicyVote = votes.some((v) =>
                policyKinds.includes(v.proposalKind),
            );
            if (hasPolicyVote) {
                await markDaoDirty(treasuryId);
            }
        }
        return results;
    };

    return {
        connector,
        accountId,
        walletAccountId,
        isInitializing,
        isAuthenticated,
        hasAcceptedTerms,
        isAuthenticating,
        authError,
        user,
        connect,
        disconnect,
        acceptTerms,
        checkAuth,
        clearError,
        signMessage,
        signAndSendTransactions,
        createProposal,
        voteProposals,
    };
};

"use client";

import { create } from "zustand";
import {
    NearConnector,
    SignedMessage,
    ConnectorAction,
    SignDelegateActionParams,
} from "@hot-labs/near-connect";
import { Vote as ProposalVote } from "@/lib/proposals-api";
import { ProposalPermissionKind } from "@/lib/config-utils";
import { toast } from "sonner";
import Big from "@/lib/big";
import { useQueryClient } from "@tanstack/react-query";
import { ledgerWalletManifest } from "@/lib/wallet-manifests";
import {
    getAuthChallenge,
    authLogin,
    acceptTerms as apiAcceptTerms,
    getAuthMe,
    authLogout,
    AuthUserInfo,
} from "@/lib/auth-api";
import { markDaoDirty, relayDelegateAction } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EventMap } from "@hot-labs/near-connect/build/types";
import {
    estimateProposalStorage,
    estimateVoteStorage,
} from "@/lib/sputnik-storage";
import manifests from "@hot-labs/near-connect/repository/manifest.json";

// Fallbacks if WASM estimator fails to load
const FALLBACK_PROPOSAL_STORAGE_BYTES = Big(500);
const FALLBACK_VOTE_STORAGE_BYTES = Big(100);

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

const LOGIN_MESSAGE = "Login to Trezu";
const LOGIN_RECIPIENT = "Trezu App";

interface NearStore {
    // Wallet state
    connector: NearConnector | null;
    walletAccountId: string | null; // Raw wallet account ID
    isInitializing: boolean;

    // Auth state
    isAuthenticated: boolean;
    nonce: string | null;
    hasAcceptedTerms: boolean;
    isAuthenticating: boolean;
    authError: string | null;
    user: AuthUserInfo | null;

    // Wallet actions
    init: () => Promise<NearConnector | undefined>;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;

    // Auth actions
    acceptTerms: () => Promise<void>;
    checkAuth: () => Promise<void>;
    clearError: () => void;

    // Transaction actions (require full auth)
    signMessage: (
        message: string,
    ) => Promise<{ signatureData: SignedMessage; signedData: string }>;
    signAndSendDelegateAction: (
        params: SignDelegateActionParams,
        treasuryId: string,
    ) => Promise<boolean>;
    createProposal: (
        toastMessage: string,
        params: CreateProposalParams,
        showToast: boolean,
    ) => Promise<void>;
    voteProposals: (treasuryId: string, votes: Vote[]) => Promise<void>;
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

    nonce: null,
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
                manifest: manifests as any,
                footerBranding: {
                    icon: "/favicon_dark.svg",
                    link: "https://wallet.near.org/",
                    linkText: "Need a wallet?",
                    heading: "More wallets coming soon",
                },
                features: {
                    signDelegateActions: true,
                    signInAndSignMessage: true,
                },
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
            async ({ accounts, wallet, source }: EventMap["wallet:signIn"]) => {
                console.log("source", source);
                const { nonce } = get();
                if (source !== "signIn" || nonce === null) {
                    return;
                }
                const nonceBytes = Uint8Array.from(atob(nonce ?? ""), (c) =>
                    c.charCodeAt(0),
                );
                const signatureData = await wallet.signMessage({
                    message: LOGIN_MESSAGE,
                    recipient: LOGIN_RECIPIENT,
                    nonce: nonceBytes,
                });
                const loginResponse = await authLogin({
                    accountId: accounts[0]?.accountId ?? "",
                    publicKey: accounts[0]?.publicKey ?? "",
                    signature: signatureData.signature,
                    message: LOGIN_MESSAGE,
                    nonce: nonce ?? "",
                    recipient: LOGIN_RECIPIENT,
                });
                set({
                    walletAccountId: accounts[0]?.accountId ?? null,
                    isAuthenticated: true,
                    hasAcceptedTerms: loginResponse.termsAccepted,
                    user: {
                        accountId: loginResponse.accountId,
                        termsAccepted: loginResponse.termsAccepted,
                    },
                    nonce: null,
                    isAuthenticating: false,
                });
            },
        );

        newConnector.on(
            "wallet:signInAndSignMessage",
            async ({ accounts }: EventMap["wallet:signInAndSignMessage"]) => {
                const result = accounts[0];
                const loginResponse = await authLogin({
                    accountId: result.signedMessage.accountId,
                    publicKey: result.signedMessage.publicKey ?? "",
                    signature: result.signedMessage.signature,
                    message: LOGIN_MESSAGE,
                    nonce: get().nonce ?? "",
                    recipient: LOGIN_RECIPIENT,
                });
                set({
                    walletAccountId: result.accountId,
                    isAuthenticated: true,
                    hasAcceptedTerms: loginResponse.termsAccepted,
                    user: {
                        accountId: loginResponse.accountId,
                        termsAccepted: loginResponse.termsAccepted,
                    },
                    isAuthenticating: false,
                    nonce: null,
                });
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

        set({ isInitializing: false });
        return newConnector;
    },

    connect: async () => {
        const { connector, init } = get();
        const newConnector = connector ?? (await init());
        if (!newConnector) {
            throw new Error("Failed to initialize connector");
        }

        set({ isAuthenticating: true, authError: null });

        try {
            // Get challenge from backend
            const { nonce } = await getAuthChallenge();

            set({ nonce });
            // Decode base64 nonce to Uint8Array
            const nonceBytes = Uint8Array.from(atob(nonce), (c) =>
                c.charCodeAt(0),
            );

            // Sign the message with wallet
            try {
                await newConnector.connect({
                    signMessageParams: {
                        message: LOGIN_MESSAGE,
                        recipient: LOGIN_RECIPIENT,
                        nonce: nonceBytes,
                    },
                });
            } catch (error) {
                console.log("ERROR HAPPENED WHY", error);
                await newConnector.connect();
            }
        } catch (error) {
            console.error("Authentication failed:", error);
            set({
                isAuthenticating: false,
                authError:
                    error instanceof Error
                        ? error.message
                        : "Authentication failed",
            });
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
                        termsAccepted: true,
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
                    hasAcceptedTerms: user.termsAccepted,
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

    signAndSendDelegateAction: async (
        params: SignDelegateActionParams,
        treasuryId: string,
    ): Promise<boolean> => {
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
        const result = await wallet.signDelegateActions(params);

        // Relay each signed delegate action to the backend for gas-sponsored submission
        for (const signedAction of result.signedDelegateActions) {
            const relayResult = await relayDelegateAction(
                treasuryId,
                signedAction,
            );
            if (!relayResult.success) {
                throw new Error(
                    relayResult.error || "Failed to relay delegate action",
                );
            }
        }

        return true;
    },

    createProposal: async (
        toastMessage: string,
        params: CreateProposalParams,
        showToast: boolean = true,
    ) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            toast.error("Please connect wallet and accept terms to continue.");
            throw new Error(
                "Not authorized. Please connect wallet and accept terms.",
            );
        }
        if (!state.connector) {
            throw new Error("Connector not initialized");
        }

        const gas = "270000000000000";

        let storageBytes: Big;
        try {
            const estimated = await estimateProposalStorage(params.proposal);
            storageBytes = Big(estimated + 50);
        } catch (e) {
            storageBytes = FALLBACK_PROPOSAL_STORAGE_BYTES;
        }

        const proposalTransaction = {
            receiverId: params.treasuryId,
            actions: [
                {
                    type: "Transfer",
                    params: {
                        deposit: Big(10).pow(19).mul(storageBytes).toFixed(0),
                    },
                } as ConnectorAction,
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

        const delegateActions = transactions.map((t) => ({
            receiverId: t.receiverId,
            actions: t.actions,
        }));

        try {
            await get().signAndSendDelegateAction(
                { delegateActions, network: "mainnet" },
                params.treasuryId,
            );
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
        } catch (error) {
            console.error("Failed to create proposal:", error);
            toast.error("Transaction wasn't approved in your wallet.");
            throw error;
        }
    },

    voteProposals: async (treasuryId: string, votes: Vote[]) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            toast.error("Please connect wallet and accept terms to continue.");
            throw new Error(
                "Not authorized. Please connect wallet and accept terms.",
            );
        }

        const { signAndSendDelegateAction } = get();
        const gas = Big("300000000000000").div(votes.length).toFixed();

        let voteStorageBytes: Big;
        try {
            const action = `Vote${votes[0].vote}`;
            const estimated = await estimateVoteStorage(undefined, action);
            voteStorageBytes = Big(estimated + 10);
        } catch (e) {
            voteStorageBytes = FALLBACK_VOTE_STORAGE_BYTES;
        }

        const votesActions = votes.map((vote) => ({
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
        }));

        const delegateActions = [
            {
                receiverId: treasuryId,
                actions: [
                    {
                        type: "Transfer",
                        params: {
                            deposit: Big(10)
                                .pow(19)
                                .mul(voteStorageBytes.mul(votes.length))
                                .toFixed(0),
                        },
                    } as ConnectorAction,
                    ...votesActions,
                ],
            },
        ];

        try {
            await signAndSendDelegateAction(
                { delegateActions: delegateActions as any, network: "mainnet" },
                treasuryId,
            );

            const toastAction =
                votes.length === 1
                    ? {
                          label: "View Request",
                          onClick: () =>
                              window.open(
                                  `/${treasuryId}/requests/${votes[0].proposalId}`,
                              ),
                      }
                    : undefined;
            toast.success(
                `Your vote${votes.length > 1 ? "s" : ""} have been submitted`,
                {
                    duration: 10000,
                    action: toastAction,
                    classNames: {
                        toast: "!p-2 !px-4",
                        actionButton: cn(
                            !toastAction ? "!hidden" : "",
                            "!bg-transparent !text-foreground hover:!bg-muted !border-0",
                        ),
                        title: cn(
                            toastAction
                                ? "!border-r !border-r-border !pr-4"
                                : "!pr-0",
                        ),
                    },
                },
            );
        } catch (error) {
            console.error("Failed to vote proposals:", error);
            toast.error(`Failed to submit vote${votes.length > 1 ? "s" : ""}`);
            throw error;
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
        await storeCreateProposal(toastMessage, params, showToast);

        // Success: invalidate queries after delay in background
        (async () => {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            await queryClient.invalidateQueries({
                queryKey: ["proposals", params.treasuryId],
            });
            await queryClient.invalidateQueries({
                queryKey: ["proposal", params.treasuryId],
            });
        })();
    };

    const voteProposals = async (treasuryId: string, votes: Vote[]) => {
        await storeVoteProposals(treasuryId, votes);

        // Success: delay then invalidate
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const promises = [
            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            }),
            ...votes.map((vote) =>
                queryClient.invalidateQueries({
                    queryKey: [
                        "proposal",
                        treasuryId,
                        vote.proposalId.toString(),
                    ],
                }),
            ),
            ...votes.map((vote) =>
                queryClient.invalidateQueries({
                    queryKey: [
                        "proposal-transaction",
                        treasuryId,
                        vote.proposalId.toString(),
                    ],
                }),
            ),
        ];
        await Promise.all(promises);

        await queryClient.invalidateQueries({
            queryKey: ["treasuryPolicy", treasuryId],
        });
        await queryClient.invalidateQueries({
            queryKey: ["treasuryConfig", treasuryId],
        });
        await queryClient.invalidateQueries({
            queryKey: ["userTreasuries", accountId],
        });

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
        createProposal,
        voteProposals,
    };
};

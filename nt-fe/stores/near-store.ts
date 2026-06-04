"use client";

import { create } from "zustand";
import {
    NearConnector,
    SignedMessage,
    ConnectorAction,
} from "@hot-labs/near-connect";
import { Proposal, Vote as ProposalVote } from "@/lib/proposals-api";
import {
    ProposalPermissionKind,
    getKindFromProposal,
} from "@/lib/config-utils";
import { toast } from "sonner";
import Big from "@/lib/big";
import { useQueryClient } from "@tanstack/react-query";
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
import { getNearStoreMessages } from "@/i18n/store-messages";
import {
    EventMap,
    SignDelegateActionsParams,
} from "@hot-labs/near-connect/build/types";
import {
    estimateProposalStorage,
    estimateVoteStorage,
} from "@/lib/sputnik-storage";
import { APP_WALLET_SETUP_URL } from "@/constants/config";
import { trackEvent } from "@/lib/analytics";
import posthog from "posthog-js";

/**
 * Ensures sandboxed iframes get bluetooth permission for Ledger Nano X BLE.
 * @hot-labs/near-connect doesn't yet include bluetooth in iframe allow attributes,
 * so we patch it via MutationObserver when iframes are added to the DOM.
 */
function ensureBluetoothIframePermission() {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (
                    node instanceof HTMLIFrameElement &&
                    node.getAttribute("sandbox")?.includes("allow-scripts")
                ) {
                    const allow = node.getAttribute("allow") || "";
                    if (!allow.includes("bluetooth")) {
                        node.setAttribute(
                            "allow",
                            allow + (allow ? " " : "") + "bluetooth *;",
                        );
                    }
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

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
    /** Metric hint for the backend. "swap" | "payment" | "vote" | "other". Omit for non-tracked proposals. */
    proposalType?: string;
    /** True when payment recipient was selected from address book. */
    addressBookPayment?: boolean;
}

interface Vote {
    proposalId: number;
    vote: ProposalVote;
    proposal: Proposal;
}

const LOGIN_MESSAGE = "Login to Trezu";
const LOGIN_RECIPIENT = "Trezu App";
const LEDGER_WALLET_ID = "ledger";

interface NearStore {
    // Wallet state
    connector: NearConnector | null;
    connectorExcludeLedger: boolean | null;
    walletAccountId: string | null; // Raw wallet account ID
    isInitializing: boolean;

    // Auth state
    nonce: string | null;
    isAuthenticated: boolean;
    hasAcceptedTerms: boolean;
    isAuthenticating: boolean;
    authError: string | null;
    user: AuthUserInfo | null;

    // Wallet actions
    init: (options?: {
        excludeLedger?: boolean;
    }) => Promise<NearConnector | undefined>;
    connect: (walletId?: string) => Promise<void>;
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
        treasuryId: string,
        params: SignDelegateActionsParams,
        storageBytes: Big,
        proposalType?: string,
        addressBookPayment?: boolean,
    ) => Promise<boolean>;
    createProposal: (params: CreateProposalParams) => Promise<void>;
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
    connectorExcludeLedger: null,
    walletAccountId: null,
    isInitializing: true,

    // Auth state
    nonce: null,
    isAuthenticated: false,
    hasAcceptedTerms: false,
    isAuthenticating: false,
    authError: null,
    user: null,

    init: async (options) => {
        const { connector, connectorExcludeLedger } = get();
        const requestedExcludeLedger = options?.excludeLedger;

        if (
            connector &&
            (requestedExcludeLedger === undefined ||
                connectorExcludeLedger === requestedExcludeLedger)
        ) {
            return connector;
        }
        const shouldExcludeLedger = requestedExcludeLedger ?? true;

        let newConnector = null;

        ensureBluetoothIframePermission();

        try {
            newConnector = new NearConnector({
                network: "mainnet",
                footerBranding: {
                    icon: "/favicon_dark.svg",
                    link: APP_WALLET_SETUP_URL ?? "https://wallet.near.org",
                    linkText: "Need a wallet?",
                    heading: "More wallets coming soon",
                },
                features: {
                    signDelegateActions: true,
                    signInAndSignMessage: true,
                },
                excludedWallets: shouldExcludeLedger ? [LEDGER_WALLET_ID] : [],
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
                trackEvent("wallet-selected", {
                    wallet_id: wallet.manifest.id,
                    wallet_name: wallet.manifest.name,
                });
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
                        hasAcceptedV1Terms:
                            loginResponse.hasAcceptedV1Terms ?? false,
                    },
                    nonce: null,
                    isAuthenticating: false,
                });
                posthog.identify(loginResponse.accountId, {
                    account_id: loginResponse.accountId,
                });
                trackEvent("wallet_connection_completed", {
                    source: "wallet-sign-in",
                    account_id: loginResponse.accountId,
                });
            },
        );

        newConnector.on(
            "wallet:signInAndSignMessage",
            async ({
                accounts,
                wallet,
            }: EventMap["wallet:signInAndSignMessage"]) => {
                trackEvent("wallet-selected", {
                    wallet_id: wallet.manifest.id,
                    wallet_name: wallet.manifest.name,
                });
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
                        hasAcceptedV1Terms:
                            loginResponse.hasAcceptedV1Terms ?? false,
                    },
                    isAuthenticating: false,
                    nonce: null,
                });
                posthog.identify(loginResponse.accountId, {
                    account_id: loginResponse.accountId,
                });
                trackEvent("wallet_connection_completed", {
                    source: "wallet-sign-in-and-message",
                    account_id: loginResponse.accountId,
                });
            },
        );

        set({
            connector: newConnector,
            connectorExcludeLedger: shouldExcludeLedger,
        });
        set({ isInitializing: false });
        return newConnector;
    },

    connect: async (walletId?: string) => {
        const { init } = get();
        const shouldExcludeLedger = walletId !== LEDGER_WALLET_ID;
        const newConnector = await init({
            excludeLedger: shouldExcludeLedger,
        });
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
            await newConnector.connect({
                walletId,
                signMessageParams: {
                    message: LOGIN_MESSAGE,
                    recipient: LOGIN_RECIPIENT,
                    nonce: nonceBytes,
                },
            });
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
        posthog.reset();

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
            trackEvent("wallet_connection_completed", {
                source: "terms-accepted",
                account_id: get().walletAccountId ?? undefined,
            });
        } catch (error) {
            console.error("Failed to accept terms:", error);
            throw error;
        }
    },

    checkAuth: async () => {
        try {
            const user = await getAuthMe();
            if (user) {
                // Verify the wallet connector still has accounts (e.g. localStorage wasn't cleared).
                // If wallet state is gone, the session cookie is useless — log out.
                const { connector, init } = get();
                const conn = connector ?? (await init());
                let walletValid = false;
                if (conn) {
                    try {
                        await conn.wallet();
                        walletValid = true;
                    } catch {
                        // Wallet has no accounts — localStorage was likely cleared
                    }
                }

                if (!walletValid) {
                    try {
                        await authLogout();
                    } catch {
                        // ignore logout errors
                    }
                    set({
                        isAuthenticated: false,
                        hasAcceptedTerms: false,
                        user: null,
                        walletAccountId: null,
                    });
                    return;
                }

                set({
                    isAuthenticated: true,
                    hasAcceptedTerms: user.termsAccepted,
                    user: {
                        ...user,
                        hasAcceptedV1Terms: user.hasAcceptedV1Terms ?? false,
                    },
                    walletAccountId: user.accountId,
                });
                posthog.identify(user.accountId, {
                    account_id: user.accountId,
                });
            } else {
                set({
                    isAuthenticated: false,
                    hasAcceptedTerms: false,
                    user: null,
                    walletAccountId: null,
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
        treasuryId: string,
        params: SignDelegateActionsParams,
        storageBytes: Big,
        proposalType?: string,
        addressBookPayment?: boolean,
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

        // Relay each signed delegate action to the backend for gas-sponsored submission.
        // proposalType is only passed for the first action (the actual proposal/vote);
        // subsequent actions are helper calls like storage_deposit.
        for (let i = 0; i < result.signedDelegateActions.length; i++) {
            const relayResult = await relayDelegateAction(
                treasuryId,
                result.signedDelegateActions[i],
                storageBytes,
                i === 0 ? proposalType : undefined,
                i === 0 ? addressBookPayment : undefined,
            );
            if (!relayResult.success) {
                throw new Error(
                    relayResult.error || "Failed to relay delegate action",
                );
            }
        }

        return true;
    },

    createProposal: async (params: CreateProposalParams) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            toast.error(getNearStoreMessages().connectAndAcceptTerms);
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
            const estimated = await estimateProposalStorage(
                state.walletAccountId ?? "",
                params.proposal,
            );
            storageBytes = Big(estimated + 50);
        } catch (e) {
            console.error("Failed to estimate vote storage:", e);
            storageBytes = FALLBACK_PROPOSAL_STORAGE_BYTES;
        }

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

        const delegateActions = transactions.map((t) => ({
            receiverId: t.receiverId,
            actions: t.actions,
        }));

        try {
            await get().signAndSendDelegateAction(
                params.treasuryId,
                { delegateActions, network: "mainnet" },
                storageBytes,
                params.proposalType,
                params.addressBookPayment,
            );
        } catch (error) {
            console.error("Failed to create proposal:", error);
            toast.error(getNearStoreMessages().transactionNotApproved);
            throw error;
        }
    },

    voteProposals: async (treasuryId: string, votes: Vote[]) => {
        const state = get();
        if (!isFullyAuthenticated(state)) {
            toast.error(getNearStoreMessages().connectAndAcceptTerms);
            throw new Error(
                "Not authorized. Please connect wallet and accept terms.",
            );
        }

        const { signAndSendDelegateAction } = get();
        const gas = Big("300000000000000").div(votes.length).toFixed();

        let voteStorageBytes: Big;
        try {
            const estimations = await Promise.all(
                votes.map((vote) =>
                    estimateVoteStorage(
                        state.walletAccountId ?? "",
                        vote.proposal,
                        `Vote${vote.vote}`,
                    ),
                ),
            );
            voteStorageBytes = estimations.reduce(
                (sum, bytes) => sum.add(bytes + 10),
                Big(0),
            );
        } catch (e) {
            console.error("Failed to estimate vote storage:", e);
            voteStorageBytes = FALLBACK_VOTE_STORAGE_BYTES.mul(votes.length);
        }

        const votesActions = votes.map((vote) => ({
            type: "FunctionCall",
            params: {
                methodName: "act_proposal",
                args: {
                    id: vote.proposalId,
                    action: `Vote${vote.vote}`,
                    proposal: vote.proposal.kind,
                },
                gas: gas.toString(),
                deposit: "0",
            },
        }));

        const delegateActions = [
            {
                receiverId: treasuryId,
                actions: votesActions as ConnectorAction[],
            },
        ];

        try {
            await signAndSendDelegateAction(
                treasuryId,
                { delegateActions, network: "mainnet" },
                voteStorageBytes,
                "vote",
            );
            trackEvent("proposal-voted", {
                vote: votes[0]?.vote.toLowerCase(),
                proposals_count: votes.length,
                treasury_id: treasuryId,
            });
        } catch (error) {
            console.error("Failed to vote proposals:", error);
            toast.error(
                votes.length > 1
                    ? getNearStoreMessages().failedSubmitVotes
                    : getNearStoreMessages().failedSubmitVote,
            );
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
        await storeCreateProposal(params);
        // Invalidate queries after delay
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const promises = [
            queryClient.invalidateQueries({
                queryKey: ["proposals", params.treasuryId],
            }),
            queryClient.invalidateQueries({
                queryKey: ["proposal", params.treasuryId],
            }),
        ];
        await Promise.all(promises);

        // Show toast after invalidation
        if (showToast) {
            toast.success(toastMessage, {
                duration: 10000,
                action: {
                    label: getNearStoreMessages().viewRequest,
                    onClick: () =>
                        window.open(
                            `/${params.treasuryId}/requests?tab=InProgress`,
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
    };

    const voteProposals = async (treasuryId: string, votes: Vote[]) => {
        await storeVoteProposals(treasuryId, votes);
        // Invalidate queries after delay and show toast simultaneously
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Show toast at the same time as UI updates
        const toastAction =
            votes.length === 1 && votes[0].vote !== "Remove"
                ? {
                      label: getNearStoreMessages().viewRequest,
                      onClick: () =>
                          window.open(
                              `/${treasuryId}/requests/${votes[0].proposalId}`,
                          ),
                  }
                : undefined;
        const messages = getNearStoreMessages();
        const text =
            votes.length === 1 && votes[0].vote === "Remove"
                ? messages.proposalRemoved
                : votes.length > 1
                  ? messages.votesSubmitted
                  : messages.voteSubmitted;
        toast.success(text, {
            duration: 10000,
            action: toastAction,
            classNames: {
                toast: "!p-2 !px-4",
                actionButton: cn(
                    !toastAction ? "!hidden" : "",
                    "!bg-transparent !text-foreground hover:!bg-muted !border-0",
                ),
                title: cn(
                    toastAction ? "!border-r !border-r-border !pr-4" : "!pr-0",
                ),
            },
        });

        // Trigger invalidations (UI updates happen as queries refetch)
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

        // Run policy-related invalidations in background
        (async () => {
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
            const hasPolicyVote = votes.some((v) => {
                const kind = getKindFromProposal(v.proposal.kind);
                return kind && policyKinds.includes(kind);
            });
            if (hasPolicyVote) {
                await markDaoDirty(treasuryId);
            }
        })();
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

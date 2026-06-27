"use client";

import {
    type ConnectorAction,
    NearConnector,
    type SignedMessage,
} from "@hot-labs/near-connect";
import type { SignDelegateActionsParams } from "@hot-labs/near-connect/build/types";
import { useQueryClient } from "@tanstack/react-query";
import SignClient from "@walletconnect/sign-client";
import posthog from "posthog-js";
import { toast } from "sonner";
import { create } from "zustand";
import { APP_WALLET_SETUP_URL } from "@/constants/config";
import { markPaymentPending } from "@/features/onboarding/payment-pending";
import { getNearStoreMessages } from "@/i18n/store-messages";
import { trackEvent } from "@/lib/analytics";
import { markDaoDirty, relayDelegateAction } from "@/lib/api";
import {
    type AuthUserInfo,
    acceptTerms as apiAcceptTerms,
    authLogin,
    authLogout,
    getAuthChallenge,
    getAuthMe,
} from "@/lib/auth-api";
import Big from "@/lib/big";
import {
    getKindFromProposal,
    type ProposalPermissionKind,
} from "@/lib/config-utils";
import type { Proposal, Vote as ProposalVote } from "@/lib/proposals-api";
import { clearSessionQueries } from "@/lib/session-query-cleanup";
import {
    estimateProposalStorage,
    estimateVoteStorage,
} from "@/lib/sputnik-storage";
import { cn } from "@/lib/utils";

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

// NEP-641 authorization purpose + bare recipient. Must match the backend's
// AUTH_PURPOSE / AUTH_RECIPIENT (nt-be/src/auth/handlers.rs).
const LOGIN_PURPOSE = "PROVE_OWNERSHIP" as const;
const LOGIN_RECIPIENT = "Trezu App";
const LEDGER_WALLET_ID = "ledger";
const WALLETCONTRACT_EIP712_WALLET_ID = "walletcontract-eip712";
// Wallets that get their own dedicated button and are triggered directly by id
// through NearConnect, so they are excluded from the generic "near" wallet
// selector popup. When connecting one of these, only the others are excluded.
const DIRECT_TRIGGER_WALLET_IDS = [
    LEDGER_WALLET_ID,
    WALLETCONTRACT_EIP712_WALLET_ID,
];
// localStorage key @hot-labs/near-connect uses to remember the chosen wallet
// (so `connector.wallet()` resolves it on later calls and after reload).
const SELECTED_WALLET_STORAGE_KEY = "selected-wallet";
// Our own copy of the forced direct-trigger wallet id (Ledger / EIP-712).
// SELECTED_WALLET_STORAGE_KEY alone isn't enough: on reload the connector must
// be rebuilt INCLUDING that wallet (not excluded), otherwise `connector.wallet()`
// can't resolve it and the user is signed out. We persist the forced target
// here and restore it on bare init().
const TARGET_WALLET_STORAGE_KEY = "trezu:target-wallet";

// WalletConnect Core must be initialized exactly once per page. The connector
// is rebuilt whenever the excluded-wallet set changes (e.g. switching to the
// EIP-712 walletcontract button), so we memoize a single SignClient and reuse
// it across rebuilds. Re-initializing would trigger "WalletConnect Core is
// already initialized" and strand the in-flight session, dropping the
// signMessage result before it reaches the eip712 executor.
let walletConnectClient: ReturnType<typeof SignClient.init> | null = null;
function getWalletConnectClient(): ReturnType<typeof SignClient.init> {
    if (!walletConnectClient) {
        walletConnectClient = SignClient.init({
            projectId: "127abc3c78912e30217f188a8c6f22c0",
            metadata: {
                name: "Trezu App",
                description: "Confidential Multisig",
                url: location.origin,
                icons: ["/favicon_light.svg", "/favicon_dark.svg"],
            },
        });
    }
    return walletConnectClient;
}

interface NearStore {
    // Wallet state
    connector: NearConnector | null;
    // Comma-joined list of excluded wallet ids the current connector was built
    // with; used to decide whether it can be reused or must be rebuilt.
    connectorExcludeKey: string | null;
    walletAccountId: string | null; // Raw wallet account ID
    isInitializing: boolean;

    // Auth state
    isAuthenticated: boolean;
    hasAcceptedTerms: boolean;
    isAuthenticating: boolean;
    authError: string | null;
    user: AuthUserInfo | null;

    // Wallet actions
    init: (options?: {
        targetWalletId?: string;
    }) => Promise<NearConnector | undefined>;
    connect: (
        walletId?: string,
        onboardingPage?: "/" | "/create",
    ) => Promise<void>;
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
    connectorExcludeKey: null,
    walletAccountId: null,
    isInitializing: true,

    // Auth state
    isAuthenticated: false,
    hasAcceptedTerms: false,
    isAuthenticating: false,
    authError: null,
    user: null,

    init: async (options) => {
        const { connector, connectorExcludeKey } = get();

        // On a bare init() (app bootstrap / auth check, e.g. after a page
        // reload) restore the previously forced direct-trigger wallet from our
        // dedicated key, so the rebuilt connector still includes it and
        // `connector.wallet()` can resolve the session. Explicit connect() calls
        // pass an options object and control the target themselves.
        const persistedTarget =
            typeof window !== "undefined"
                ? window.localStorage.getItem(TARGET_WALLET_STORAGE_KEY)
                : null;
        const restoredTarget =
            persistedTarget &&
            DIRECT_TRIGGER_WALLET_IDS.includes(persistedTarget)
                ? persistedTarget
                : undefined;
        const targetWalletId =
            options === undefined ? restoredTarget : options.targetWalletId;

        // Only the generic "NEAR" path (no forced wallet) excludes the
        // direct-trigger wallets from the selector popup. Forcing a specific
        // wallet (Ledger / EIP-712) excludes nothing.
        const excludedWallets = targetWalletId
            ? []
            : [...DIRECT_TRIGGER_WALLET_IDS];
        const excludeKey = excludedWallets.join(",");

        // Reuse the existing connector when its exclusion set already matches
        // what we need, or when no specific wallet is targeted.
        if (
            connector &&
            (targetWalletId === undefined || connectorExcludeKey === excludeKey)
        ) {
            return connector;
        }

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
                    resolveAuth: true,
                },
                excludedWallets,
                walletConnect: getWalletConnectClient(),
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
                isAuthenticating: false,
                user: null,
                authError: null,
            });
            posthog.reset();
        });

        // Login is driven explicitly in `connect()` via NEP-641 `resolveAuth`,
        // so no sign-in event handlers are needed here.

        set({
            connector: newConnector,
            connectorExcludeKey: excludeKey,
        });
        set({ isInitializing: false });
        return newConnector;
    },

    connect: async (walletId?: string, onboardingPage?: "/" | "/create") => {
        const { init } = get();
        const newConnector = await init({ targetWalletId: walletId });
        if (!newConnector) {
            throw new Error("Failed to initialize connector");
        }

        set({ isAuthenticating: true, authError: null });

        try {
            // 1. Backend issues a unique payload to authorize.
            const { payload } = await getAuthChallenge();

            // 2. Let the user pick a wallet (filtered to NEP-641-capable ones)
            //    and remember it so later `connector.wallet()` calls resolve it.
            const selectedWalletId =
                walletId ??
                (await newConnector.selectWallet({
                    features: { resolveAuth: true },
                }));
            if (typeof window !== "undefined") {
                window.localStorage.setItem(
                    SELECTED_WALLET_STORAGE_KEY,
                    selectedWalletId,
                );
                // Persist direct-trigger wallets under our own key so the
                // connector is rebuilt including them after a reload. Clear it
                // for generic NEAR wallets, which need no special inclusion.
                if (DIRECT_TRIGGER_WALLET_IDS.includes(selectedWalletId)) {
                    window.localStorage.setItem(
                        TARGET_WALLET_STORAGE_KEY,
                        selectedWalletId,
                    );
                } else {
                    window.localStorage.removeItem(TARGET_WALLET_STORAGE_KEY);
                }
            }
            const wallet = await newConnector.wallet(selectedWalletId);

            trackEvent("wallet-selected", {
                wallet_id: wallet.manifest.id,
                wallet_name: wallet.manifest.name,
            });

            // 3. NEP-641 PROVE_OWNERSHIP: sign in and authorize in one gesture.
            //    Produces an authorization blob the backend resolves on-chain.
            const { accountId, authorization } = await wallet.resolveAuth!({
                network: "mainnet",
                purpose: LOGIN_PURPOSE,
                recipient: LOGIN_RECIPIENT,
                payload,
            });

            // 4. Backend verifies the authorization and opens a session.
            const loginResponse = await authLogin({ accountId, authorization });

            set({
                walletAccountId: accountId,
                isAuthenticated: true,
                hasAcceptedTerms: loginResponse.termsAccepted,
                user: {
                    accountId: loginResponse.accountId,
                    termsAccepted: loginResponse.termsAccepted,
                    hasAcceptedV1Terms:
                        loginResponse.hasAcceptedV1Terms ?? false,
                },
                isAuthenticating: false,
            });
            posthog.identify(loginResponse.accountId, {
                account_id: loginResponse.accountId,
            });
            trackEvent("wallet_connection_completed", {
                source: "resolve-auth",
                account_id: loginResponse.accountId,
            });
            if (onboardingPage) {
                trackEvent("onboarding_login_completed", {
                    page: onboardingPage,
                    account_id: loginResponse.accountId,
                });
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

        // Logout from backend first, then drop local auth state.
        try {
            await authLogout();
        } catch (error) {
            console.error("Logout error:", error);
        }

        // Reset auth state
        set({
            walletAccountId: null,
            isAuthenticated: false,
            hasAcceptedTerms: false,
            isAuthenticating: false,
            user: null,
            authError: null,
        });
        posthog.reset();

        // Forget the persisted direct-trigger wallet so the next reload doesn't
        // restore a stale target.
        if (typeof window !== "undefined") {
            window.localStorage.removeItem(TARGET_WALLET_STORAGE_KEY);
        }

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
                walletAccountId: null,
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
    const disconnectAndClearSession = async () => {
        // Logout + reset auth state first, then clear the cached session data.
        await disconnect();
        await clearSessionQueries(queryClient);
    };

    const createProposal = async (
        toastMessage: string,
        params: CreateProposalParams,
        showToast: boolean = true,
    ) => {
        await storeCreateProposal(params);
        // Signal the onboarding flow that a payment request was just made so it
        // can poll for it while the backend indexer catches up.
        if (params.proposalType === "payment") {
            markPaymentPending(params.treasuryId, queryClient);
        }
        // Invalidate queries after delay
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const promises = [
            queryClient.invalidateQueries({
                queryKey: ["proposals", params.treasuryId],
                refetchType: "all",
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
                refetchType: "all",
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
        disconnect: disconnectAndClearSession,
        acceptTerms,
        checkAuth,
        clearError,
        signMessage,
        createProposal,
        voteProposals,
    };
};

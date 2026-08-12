import axios from "axios";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { base64ToJson, nanosToMs } from "@/lib/utils";
import { useNearStore } from "@/stores/near-store";
import { sendResultToOpener } from "../utils/opener";
import { translateToProposals } from "../utils/proposals";
import type {
    ProposalData,
    TransactionRequest,
    Treasury,
    WalletAction,
    WalletProposalLabels,
    WalletStep,
} from "../utils/types";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

const APPROVAL_POLL_INTERVAL_MS = 10_000;

/**
 * The wallet popup's state machine: reads the connector's request from the
 * URL, drives auth via the shared near-store, creates sponsored proposals
 * through the relay, and polls the backend until the treasury decides.
 */
export function useWalletFlow() {
    const tWErr = useTranslations("wallet.errors");
    const tWProposal = useTranslations("wallet.proposal");
    const walletProposalLabels = useMemo<WalletProposalLabels>(
        () => ({
            transferDescription: (receiverId: string) =>
                tWProposal("transfer", { receiverId }),
            functionCallDescription: (methods: string, receiverId: string) =>
                tWProposal("functionCall", { methods, receiverId }),
            unsupportedAction: (type: string) =>
                tWProposal("unsupportedAction", { type }),
        }),
        [tWProposal],
    );
    const searchParams = useSearchParams();
    const router = useRouter();

    const {
        walletAccountId,
        isAuthenticated,
        hasAcceptedTerms,
        isAuthenticating,
        authError,
        connect,
        createProposal,
    } = useNearStore();
    // Only a fully authenticated account (session + terms) can act: the
    // sponsored relay requires the backend session cookie.
    const accountId =
        isAuthenticated && hasAcceptedTerms ? walletAccountId : null;

    const action = (searchParams.get("action") || "sign_in") as WalletAction;
    const callbackUrl = searchParams.get("callbackUrl") || "";
    const transactionsParam = searchParams.get("transactions") || "";
    const signerId = searchParams.get("signerId") || "";
    const daoIdParam = searchParams.get("daoId") || "";
    const proposalIdsParam = searchParams.get("proposalIds") || "";

    // The initial flow state must be derived from the URL synchronously: an
    // authenticated session mounts the page with `accountId` already set, so
    // an effect-based restore would race the treasuries fetch (which only
    // runs from the "connect" step) and lose the restored step.
    const [initial] = useState(() => {
        // Restore waiting-approval state from URL if present
        if (daoIdParam && proposalIdsParam) {
            const ids = proposalIdsParam
                .split(",")
                .map(Number)
                .filter((n) => !isNaN(n));
            if (ids.length > 0) {
                return {
                    step: "waiting-approval" as WalletStep,
                    selectedDao: daoIdParam,
                    proposalIds: ids,
                    transactions: [] as TransactionRequest[],
                    error: null as string | null,
                };
            }
        }

        // Parse transactions if present
        let transactions: TransactionRequest[] = [];
        try {
            if (transactionsParam) {
                transactions = base64ToJson(
                    transactionsParam,
                ) as TransactionRequest[];
            }
        } catch (e) {
            console.error("Failed to parse transactions:", e);
            return {
                step: "error" as WalletStep,
                selectedDao: null,
                proposalIds: [],
                transactions: [] as TransactionRequest[],
                error: tWErr("parseTx"),
            };
        }

        return {
            step: "connect" as WalletStep,
            selectedDao: null,
            proposalIds: [],
            transactions,
            error: null as string | null,
        };
    });

    const [step, setStep] = useState<WalletStep>(initial.step);
    const [treasuries, setTreasuries] = useState<Treasury[]>([]);
    const [treasuriesLoading, setTreasuriesLoading] = useState(false);
    const [selectedDao, setSelectedDao] = useState<string | null>(
        initial.selectedDao,
    );
    const [transactions] = useState<TransactionRequest[]>(initial.transactions);
    const [error, setError] = useState<string | null>(initial.error);
    const [note, setNote] = useState<string | null>(null);
    const [proposalDescription, setProposalDescription] = useState("");
    const previewProposals = useMemo(() => {
        if (!selectedDao || transactions.length === 0) return [];
        try {
            const all: ProposalData[] = [];
            for (const tx of transactions) {
                all.push(
                    ...translateToProposals(
                        selectedDao,
                        tx,
                        walletProposalLabels,
                    ),
                );
            }
            return all;
        } catch {
            return [];
        }
    }, [selectedDao, transactions, walletProposalLabels]);
    const [proposalIds, setProposalIds] = useState<number[]>(
        initial.proposalIds,
    );
    const checkingRef = useRef(false);

    // Hostname of the dApp that opened the popup, shown in the
    // treasury-selection prompt ("…use in gov.houseofstake.org").
    const dappHost = useMemo(() => {
        try {
            return callbackUrl ? new URL(callbackUrl).hostname : null;
        } catch {
            return null;
        }
    }, [callbackUrl]);

    // Fetch treasuries when the account is fully authenticated
    useEffect(() => {
        if (!accountId) return;
        // Don't re-run if we're already past the initial flow
        if (step !== "connect") return;

        setTreasuriesLoading(true);
        axios
            .get<Treasury[]>(`${BACKEND_API_BASE}/user/treasuries`, {
                params: { accountId, includeHidden: false },
            })
            .then((res) => {
                const memberTreasuries = (res.data || []).filter(
                    (t) => t.isMember,
                );
                setTreasuries(memberTreasuries);

                if (action === "sign_in") {
                    setStep("select-treasury");
                } else if (action === "sign_transactions") {
                    // If signerId matches a DAO the user is a member of, auto-select it
                    if (
                        signerId &&
                        memberTreasuries.some((t) => t.daoId === signerId)
                    ) {
                        setSelectedDao(signerId);
                        setStep("confirm-transactions");
                    } else {
                        setStep("select-treasury");
                    }
                }
            })
            .catch((err) => {
                console.error("Failed to fetch treasuries:", err);
                setError(tWErr("fetchTreasuries"));
                setStep("error");
            })
            .finally(() => setTreasuriesLoading(false));
    }, [accountId, action, signerId, step, tWErr]);

    const handleConnect = useCallback(async () => {
        // The store drives the near-connect wallet selector and the full
        // NEP-641 login (backend session); failures land in authError.
        await connect();
    }, [connect]);

    const handleSelectTreasury = useCallback(
        (daoId: string) => {
            setSelectedDao(daoId);
            if (action === "sign_in") {
                // Send the DAO account ID back to the opener as the "signed in" account
                sendResultToOpener({
                    type: "trezu:result",
                    status: "success",
                    accountId: daoId,
                    publicKey: "",
                });
                setStep("done");
            } else if (action === "sign_transactions") {
                setStep("confirm-transactions");
            }
        },
        [action],
    );

    const handleConfirmTransactions = useCallback(async () => {
        if (!selectedDao || transactions.length === 0) return;

        setStep("processing");

        try {
            // The DAO policy provides the proposal bond; the backend is the
            // single source of truth for it.
            const policyRes = await axios.get(
                `${BACKEND_API_BASE}/treasury/policy`,
                { params: { treasuryId: selectedDao } },
            );
            const proposalBond = policyRes.data?.proposal_bond || "0";

            const allProposals: ProposalData[] = [];
            for (const tx of transactions) {
                allProposals.push(
                    ...translateToProposals(
                        selectedDao,
                        tx,
                        walletProposalLabels,
                    ),
                );
            }

            // Each proposal is signed as a delegate action and relayed through
            // the backend, so gas is sponsored and the relay reports the
            // created proposal ids.
            const submittedProposalIds: number[] = [];
            for (const proposal of allProposals) {
                const ids = await createProposal({
                    treasuryId: selectedDao,
                    proposal: {
                        description:
                            proposalDescription || proposal.description,
                        kind: proposal.kind,
                    },
                    proposalBond,
                });
                submittedProposalIds.push(...ids);
            }

            if (submittedProposalIds.length === 0) {
                throw new Error(tWErr("noProposalIds"));
            }

            setProposalIds(submittedProposalIds);

            // Hand the pending proposals to the opener so the connector can
            // track them even if this window is closed.
            sendResultToOpener({
                type: "trezu:pending",
                daoId: selectedDao,
                proposalIds: submittedProposalIds,
            });

            // Persist state in URL so refresh restores this step
            const newParams = new URLSearchParams(searchParams.toString());
            newParams.set("daoId", selectedDao);
            newParams.set("proposalIds", submittedProposalIds.join(","));
            newParams.delete("transactions");
            newParams.delete("signerId");
            router.replace(`/wallet?${newParams.toString()}`);

            setStep("waiting-approval");
        } catch (e: any) {
            console.error("Failed to create proposal:", e);
            setError(e.message || tWErr("createProposalFailed"));
            setStep("error");
        }
    }, [
        selectedDao,
        transactions,
        proposalDescription,
        router,
        searchParams,
        createProposal,
        walletProposalLabels,
        tWErr,
    ]);

    const checkApproval = useCallback(async () => {
        if (checkingRef.current) return;
        if (!selectedDao || proposalIds.length === 0) return;

        checkingRef.current = true;

        try {
            // Fetch DAO policy for proposal_period (needed to compute date window)
            let proposalPeriodNs = "604800000000000"; // default 7 days in nanoseconds
            try {
                const policyRes = await axios.get(
                    `${BACKEND_API_BASE}/treasury/policy`,
                    { params: { treasuryId: selectedDao } },
                );
                if (policyRes.data?.proposal_period) {
                    proposalPeriodNs = policyRes.data.proposal_period;
                }
            } catch {
                // Use default
            }

            const txHashes: string[] = [];

            for (const proposalId of proposalIds) {
                // Fetch proposal status
                const proposalRes = await axios.get(
                    `${BACKEND_API_BASE}/proposal/${selectedDao}/${proposalId}`,
                );
                const proposal = proposalRes.data;

                // Still pending — stay on the checklist silently and let the
                // next poll pick it up.
                if (!proposal || proposal.status === "InProgress") {
                    return;
                }

                if (proposal.status !== "Approved") {
                    const statusLower = proposal.status.toLowerCase();
                    sendResultToOpener({
                        type: "trezu:result",
                        status: "failure",
                        errorMessage: tWErr("proposalWasStatus", {
                            status: statusLower,
                        }),
                    });
                    setError(
                        tWErr("wasStatus", {
                            id: proposalId,
                            status: statusLower,
                        }),
                    );
                    setStep("error");
                    return;
                }

                // Compute date window from submission_time and proposal_period
                const submissionMs = nanosToMs(proposal.submission_time);
                const expirationMs = submissionMs + nanosToMs(proposalPeriodNs);
                const afterDate = new Date(submissionMs - 24 * 60 * 60 * 1000)
                    .toISOString()
                    .split("T")[0];
                const beforeDate = new Date(
                    expirationMs + 7 * 24 * 60 * 60 * 1000,
                )
                    .toISOString()
                    .split("T")[0];

                // Proposal is approved — fetch execution transaction hash
                try {
                    const txRes = await axios.get(
                        `${BACKEND_API_BASE}/proposal/${selectedDao}/${proposalId}/tx`,
                        {
                            params: {
                                action: "VoteApprove",
                                afterDate,
                                beforeDate,
                            },
                        },
                    );
                    if (txRes.data?.transaction_hash) {
                        txHashes.push(txRes.data.transaction_hash);
                    }
                } catch {
                    // tx endpoint may fail if not indexed yet
                }
            }

            if (txHashes.length > 0) {
                sendResultToOpener({
                    type: "trezu:result",
                    status: "success",
                    transactionHashes: txHashes.join(","),
                });
                setStep("done");
            } else {
                setNote(tWErr("awaitIndex"));
            }
        } catch {
            setNote(tWErr("checkStatusFailed"));
        } finally {
            checkingRef.current = false;
        }
    }, [selectedDao, proposalIds, tWErr]);

    // Poll the proposal status while waiting for the treasury to approve, so
    // the flow progresses without any manual clicking.
    useEffect(() => {
        if (step !== "waiting-approval") return;

        void checkApproval();
        const intervalId = setInterval(() => {
            void checkApproval();
        }, APPROVAL_POLL_INTERVAL_MS);
        return () => clearInterval(intervalId);
    }, [step, checkApproval]);

    const retry = useCallback(() => {
        setError(null);
        setStep("connect");
    }, []);

    return {
        step,
        action,
        accountId,
        isAuthenticating,
        authError,
        dappHost,
        treasuries,
        treasuriesLoading,
        selectedDao,
        transactions,
        previewProposals,
        proposalIds,
        proposalDescription,
        setProposalDescription,
        note,
        error,
        handleConnect,
        handleSelectTreasury,
        handleConfirmTransactions,
        retry,
    };
}

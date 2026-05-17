"use client";

import {
    Suspense,
    useEffect,
    useState,
    useCallback,
    useRef,
    useMemo,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { NearConnector } from "@hot-labs/near-connect";
import type { Network, EventMap } from "@hot-labs/near-connect/build/types";
import axios from "axios";
import Logo from "@/components/icons/logo";
import { LoadingScreen } from "@/components/loading-screen";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import { TransferExpanded } from "@/features/proposals/components/expanded-view/transfer-expanded";
import { FunctionCallExpanded } from "@/features/proposals/components/expanded-view/function-call-expanded";
import type { Proposal, ProposalKind } from "@/lib/proposals-api";
import type {
    PaymentRequestData,
    FunctionCallData,
} from "@/features/proposals/types/index";
import { jsonToBase64, base64ToJson, nanosToMs } from "@/lib/utils";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

interface Treasury {
    daoId: string;
    config: {
        name?: string;
        purpose?: string;
        metadata?: { flagLogo?: string };
    };
    isMember: boolean;
}

interface TransactionRequest {
    receiverId: string;
    actions: Array<{
        type: string;
        params: {
            methodName: string;
            args: any;
            gas: string;
            deposit: string;
        };
    }>;
}

type WalletAction = "sign_in" | "sign_transactions";

interface ProposalData {
    receiverId: string;
    description: string;
    kind: any;
}

interface WalletProposalLabels {
    transferDescription: (receiverId: string) => string;
    functionCallDescription: (methods: string, receiverId: string) => string;
    unsupportedAction: (type: string) => string;
}

function translateToProposals(
    daoId: string,
    tx: TransactionRequest,
    labels: WalletProposalLabels,
): ProposalData[] {
    const proposals: ProposalData[] = [];
    const functionCallActions: TransactionRequest["actions"] = [];

    for (const action of tx.actions) {
        switch (action.type) {
            case "Transfer":
                proposals.push({
                    receiverId: daoId,
                    description: labels.transferDescription(tx.receiverId),
                    kind: {
                        Transfer: {
                            msg: null,
                            amount: action.params.deposit,
                            token_id: "",
                            receiver_id: tx.receiverId,
                        },
                    },
                });
                break;

            case "FunctionCall":
                functionCallActions.push(action);
                break;

            default:
                throw new Error(labels.unsupportedAction(action.type));
        }
    }

    // Group all FunctionCall actions into a single FunctionCall proposal
    if (functionCallActions.length > 0) {
        const actions = functionCallActions.map((a) => ({
            method_name: a.params.methodName,
            args: jsonToBase64(a.params.args),
            gas: a.params.gas,
            deposit: a.params.deposit,
        }));

        proposals.push({
            receiverId: daoId,
            description: labels.functionCallDescription(
                functionCallActions.map((a) => a.params.methodName).join(", "),
                tx.receiverId,
            ),
            kind: {
                FunctionCall: {
                    receiver_id: tx.receiverId,
                    actions,
                },
            },
        });
    }

    return proposals;
}

function toSyntheticProposal(proposalData: ProposalData): Proposal {
    return {
        id: 0,
        description: proposalData.description,
        kind: proposalData.kind as ProposalKind,
        status: "InProgress",
        proposer: "",
        submission_time: "0",
        vote_counts: {},
        votes: {},
        last_actions_log: null,
    };
}

function ProposalPreview({ proposalData }: { proposalData: ProposalData }) {
    const synthetic = toSyntheticProposal(proposalData);
    const { type, data } = extractProposalData(synthetic);

    switch (type) {
        case "Payment Request":
            return <TransferExpanded data={data as PaymentRequestData} />;
        case "Function Call":
            return <FunctionCallExpanded data={data as FunctionCallData} />;
        default:
            return (
                <p className="text-sm text-muted-foreground">{type} proposal</p>
            );
    }
}

function sendResultToOpener(data: Record<string, unknown>) {
    if (window.opener) {
        window.opener.postMessage(data, "*");
    }
}

export default function WalletPage() {
    return (
        <Suspense fallback={<LoadingScreen />}>
            <WalletPageContent />
        </Suspense>
    );
}

function WalletPageContent() {
    const tW = useTranslations("wallet");
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

    const action = (searchParams.get("action") || "sign_in") as WalletAction;
    const network = (searchParams.get("network") || "mainnet") as Network;
    const callbackUrl = searchParams.get("callbackUrl") || "";
    const transactionsParam = searchParams.get("transactions") || "";
    const signerId = searchParams.get("signerId") || "";
    const daoIdParam = searchParams.get("daoId") || "";
    const proposalIdsParam = searchParams.get("proposalIds") || "";

    const [step, setStep] = useState<
        | "loading"
        | "connect"
        | "select-treasury"
        | "confirm-transactions"
        | "processing"
        | "waiting-approval"
        | "done"
        | "error"
    >("loading");
    const [connector, setConnector] = useState<NearConnector | null>(null);
    const [accountId, setAccountId] = useState<string | null>(null);
    const [treasuries, setTreasuries] = useState<Treasury[]>([]);
    const [selectedDao, setSelectedDao] = useState<string | null>(null);
    const [transactions, setTransactions] = useState<TransactionRequest[]>([]);
    const [error, setError] = useState<string | null>(null);
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
    }, [selectedDao, transactions]);
    const [proposalIds, setProposalIds] = useState<number[]>([]);
    const [approvalLoading, setApprovalLoading] = useState(false);
    const initRef = useRef(false);

    // Initialize NEAR connector
    useEffect(() => {
        if (initRef.current) return;
        initRef.current = true;

        const nc = new NearConnector({ network });

        nc.on("wallet:signIn", async (t: EventMap["wallet:signIn"]) => {
            const acct = t.accounts[0]?.accountId;
            if (acct) {
                setAccountId(acct);
            }
        });

        nc.on(
            "wallet:signInAndSignMessage",
            async (t: EventMap["wallet:signInAndSignMessage"]) => {
                const acct = t.accounts[0]?.accountId;
                if (acct) {
                    setAccountId(acct);
                }
            },
        );

        nc.on("wallet:signOut", () => {
            setAccountId(null);
        });

        // Check if already connected
        nc.wallet()
            .then(async (w) => {
                const accounts = await w.getAccounts();
                if (accounts[0]?.accountId) {
                    setAccountId(accounts[0].accountId);
                }
            })
            .catch(() => {});

        setConnector(nc);

        // Restore waiting-approval state from URL if present
        if (daoIdParam && proposalIdsParam) {
            const ids = proposalIdsParam
                .split(",")
                .map(Number)
                .filter((n) => !isNaN(n));
            if (ids.length > 0) {
                setSelectedDao(daoIdParam);
                setProposalIds(ids);
                setStep("waiting-approval");
                return;
            }
        }

        // Parse transactions if present
        if (transactionsParam) {
            try {
                const txs = base64ToJson(
                    transactionsParam,
                ) as TransactionRequest[];
                setTransactions(txs);
            } catch (e) {
                console.error("Failed to parse transactions:", e);
                setError(tWErr("parseTx"));
                setStep("error");
                return;
            }
        }

        setStep("connect");
    }, [transactionsParam, daoIdParam, proposalIdsParam, network]);

    // Fetch treasuries when account is connected
    useEffect(() => {
        if (!accountId) return;
        // Don't re-run if we're already past the initial flow
        if (step !== "connect" && step !== "loading") return;

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
            });
    }, [accountId, action, signerId, step]);

    const handleConnect = useCallback(async () => {
        if (!connector) return;
        try {
            await connector.connect({});
        } catch (e) {
            console.error("Connection failed:", e);
            setError(tWErr("connectFailed"));
            setStep("error");
        }
    }, [connector]);

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
        if (!connector || !selectedDao || transactions.length === 0) return;

        setStep("processing");

        try {
            const wallet = await connector.wallet();

            // Fetch the DAO policy to get the correct proposal bond
            let proposalBond = "0";
            try {
                const policyRes = await axios.get(
                    `${BACKEND_API_BASE}/treasury/policy`,
                    { params: { treasuryId: selectedDao } },
                );
                proposalBond = policyRes.data?.proposal_bond || proposalBond;
            } catch {
                // Fallback: try RPC directly
                try {
                    const rpcRes = await fetch("https://rpc.mainnet.near.org", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            jsonrpc: "2.0",
                            id: "1",
                            method: "query",
                            params: {
                                request_type: "call_function",
                                finality: "final",
                                account_id: selectedDao,
                                method_name: "get_policy",
                                args_base64: btoa("{}"),
                            },
                        }),
                    });
                    const rpcData = await rpcRes.json();
                    if (rpcData.result?.result) {
                        const policy = JSON.parse(
                            new TextDecoder().decode(
                                new Uint8Array(rpcData.result.result),
                            ),
                        );
                        proposalBond = policy.proposal_bond || "0";
                    }
                } catch {
                    // Use default
                }
            }

            // Translate each transaction into add_proposal calls
            const submittedProposalIds: number[] = [];
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

            for (const proposal of allProposals) {
                const description = proposalDescription || proposal.description;

                const proposalArgs = {
                    proposal: {
                        description,
                        kind: proposal.kind,
                    },
                };

                // Sign and send via the user's real wallet through NEAR Connect
                const result = await wallet.signAndSendTransaction({
                    receiverId: selectedDao,
                    actions: [
                        {
                            type: "FunctionCall",
                            params: {
                                methodName: "add_proposal",
                                args: proposalArgs,
                                gas: "100000000000000",
                                deposit: proposalBond,
                            },
                        },
                    ],
                });

                // Extract proposal ID from transaction result
                // add_proposal returns the proposal ID as a number
                let proposalId: number | null = null;
                try {
                    // Shape varies by wallet provider, use any to access
                    const r = result as any;
                    const successValue =
                        r?.status?.SuccessValue ||
                        r?.transaction_outcome?.outcome?.status?.SuccessValue;
                    if (successValue) {
                        proposalId = base64ToJson(successValue);
                    }
                } catch {
                    // Cannot determine proposal ID
                }

                if (proposalId !== null) {
                    submittedProposalIds.push(proposalId);
                }
            }

            setProposalIds(submittedProposalIds);

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
        connector,
        selectedDao,
        transactions,
        proposalDescription,
        router,
        searchParams,
        action,
    ]);

    const handleProceed = useCallback(async () => {
        if (!selectedDao || proposalIds.length === 0) return;

        setApprovalLoading(true);
        setError(null);

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

                if (!proposal || proposal.status === "InProgress") {
                    setApprovalLoading(false);
                    setError(tWErr("stillPending"));
                    return;
                }

                if (proposal.status !== "Approved") {
                    setApprovalLoading(false);
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
                setApprovalLoading(false);
                setError(tWErr("awaitIndex"));
            }
        } catch (e: any) {
            setApprovalLoading(false);
            setError(e.message || tWErr("checkStatusFailed"));
        }
    }, [selectedDao, proposalIds]);

    const handleCancel = useCallback(() => {
        sendResultToOpener({
            type: "trezu:result",
            status: "failure",
            errorMessage: tWErr("userCancelled"),
        });
        window.close();
    }, [tWErr]);

    return (
        <div className="min-h-screen flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-lg overflow-hidden">
                {/* Header */}
                <div className="p-6 border-b border-border bg-muted/30">
                    <div className="flex items-center gap-3">
                        <Logo size="lg" />
                    </div>
                </div>

                {/* Content */}
                <div className="p-6">
                    {step === "loading" && (
                        <div className="text-center py-8">
                            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                            <p className="text-muted-foreground">
                                {tW("loading")}
                            </p>
                        </div>
                    )}

                    {step === "connect" && !accountId && (
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                {tW("connectPrompt")}
                            </p>
                            <button
                                type="button"
                                onClick={handleConnect}
                                className="w-full py-3 px-4 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
                            >
                                {tW("connectWallet")}
                            </button>
                            <button
                                type="button"
                                onClick={handleCancel}
                                className="w-full py-2 px-4 text-muted-foreground hover:text-foreground transition-colors text-sm"
                            >
                                {tW("cancel")}
                            </button>
                        </div>
                    )}

                    {step === "connect" && accountId && (
                        <div className="text-center py-8">
                            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                            <p className="text-sm text-muted-foreground">
                                {tW.rich("connectedAs", {
                                    account: accountId,
                                    strong: (chunks) => (
                                        <span className="font-mono font-medium text-foreground">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                                {tW("loadingTreasuries")}
                            </p>
                        </div>
                    )}

                    {step === "select-treasury" && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <p className="text-sm text-muted-foreground">
                                    {tW.rich("connectedAs", {
                                        account: accountId ?? "",
                                        strong: (chunks) => (
                                            <span className="font-mono font-medium text-foreground">
                                                {chunks}
                                            </span>
                                        ),
                                    })}
                                </p>
                            </div>
                            <p className="text-sm font-medium">
                                {action === "sign_in"
                                    ? tW("selectSignIn")
                                    : tW("selectSignTx")}
                            </p>
                            {treasuries.length === 0 ? (
                                <p className="text-sm text-muted-foreground text-center py-4">
                                    {tW("notMember")}
                                </p>
                            ) : (
                                <div className="space-y-2 max-h-64 overflow-y-auto">
                                    {treasuries.map((t) => (
                                        <button
                                            key={t.daoId}
                                            onClick={() =>
                                                handleSelectTreasury(t.daoId)
                                            }
                                            className="w-full p-3 text-left border border-border rounded-lg hover:bg-muted/50 transition-colors"
                                        >
                                            <div className="font-mono text-sm font-medium">
                                                {t.daoId}
                                            </div>
                                            {t.config.name && (
                                                <div className="text-xs text-muted-foreground mt-1">
                                                    {t.config.name}
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={handleCancel}
                                className="w-full py-2 px-4 text-muted-foreground hover:text-foreground transition-colors text-sm"
                            >
                                {tW("cancel")}
                            </button>
                        </div>
                    )}

                    {step === "confirm-transactions" && (
                        <div className="space-y-4">
                            <div className="p-3 bg-muted/50 rounded-lg">
                                <p className="text-xs text-muted-foreground">
                                    {tW("actingAs")}
                                </p>
                                <p className="font-mono text-sm font-medium">
                                    {selectedDao}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {tW("signedBy", {
                                        account: accountId ?? "",
                                    })}
                                </p>
                            </div>

                            <p className="text-sm font-medium">
                                {tW("createsNProposals", {
                                    count: previewProposals.length,
                                })}
                            </p>

                            {previewProposals.map((proposal, i) => (
                                <div
                                    key={i}
                                    className="border border-border rounded-lg p-3"
                                >
                                    <ProposalPreview proposalData={proposal} />
                                </div>
                            ))}

                            <div>
                                <label className="text-sm font-medium block mb-1">
                                    {tW("proposalDescriptionLabel")}
                                </label>
                                <input
                                    type="text"
                                    value={proposalDescription}
                                    onChange={(e) =>
                                        setProposalDescription(e.target.value)
                                    }
                                    placeholder={tW(
                                        "proposalDescriptionPlaceholder",
                                    )}
                                    className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background"
                                />
                            </div>

                            <button
                                type="button"
                                onClick={handleConfirmTransactions}
                                className="w-full py-3 px-4 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
                            >
                                {tW("createProposal")}
                            </button>
                            <button
                                type="button"
                                onClick={handleCancel}
                                className="w-full py-2 px-4 text-muted-foreground hover:text-foreground transition-colors text-sm"
                            >
                                {tW("cancel")}
                            </button>
                        </div>
                    )}

                    {step === "processing" && (
                        <div className="text-center py-8">
                            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                            <p className="text-muted-foreground">
                                {tW("creatingProposal")}
                            </p>
                            <p className="text-xs text-muted-foreground mt-2">
                                {tW("confirmInWallet")}
                            </p>
                        </div>
                    )}

                    {step === "waiting-approval" && (
                        <div className="space-y-4">
                            <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mx-auto">
                                <svg
                                    className="w-6 h-6 text-blue-600 dark:text-blue-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            </div>
                            <p className="text-center font-medium">
                                {tW("proposalSubmitted")}
                            </p>
                            <p className="text-sm text-muted-foreground text-center">
                                {tW("shareProposal")}
                            </p>

                            {proposalIds.map((id) => (
                                <a
                                    key={id}
                                    href={`/${selectedDao}/requests/${id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block w-full p-3 text-center border border-border rounded-lg hover:bg-muted/50 transition-colors text-sm font-mono text-primary underline"
                                >
                                    {tW("proposalLink", {
                                        daoId: selectedDao ?? "",
                                        id,
                                    })}
                                </a>
                            ))}

                            {error && (
                                <p className="text-sm text-amber-600 dark:text-amber-400 text-center">
                                    {error}
                                </p>
                            )}

                            <button
                                type="button"
                                onClick={handleProceed}
                                disabled={approvalLoading}
                                className="w-full py-3 px-4 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                            >
                                {approvalLoading
                                    ? tW("checking")
                                    : tW("proposalApprovedProceed")}
                            </button>
                            <button
                                type="button"
                                onClick={handleCancel}
                                className="w-full py-2 px-4 text-muted-foreground hover:text-foreground transition-colors text-sm"
                            >
                                {tW("cancel")}
                            </button>
                        </div>
                    )}

                    {step === "done" && (
                        <div className="text-center py-8 space-y-4">
                            <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                                <svg
                                    className="w-6 h-6 text-green-600 dark:text-green-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                    />
                                </svg>
                            </div>
                            <p className="font-medium">
                                {action === "sign_in"
                                    ? tW("signedInSuccess")
                                    : tW("proposalCreatedSuccess")}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {tW("closeWindow")}
                            </p>
                        </div>
                    )}

                    {step === "error" && (
                        <div className="text-center py-8 space-y-4">
                            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mx-auto">
                                <svg
                                    className="w-6 h-6 text-red-600 dark:text-red-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
                            </div>
                            <p className="font-medium text-red-600 dark:text-red-400">
                                {error || tW("errorGeneric")}
                            </p>
                            <button
                                type="button"
                                onClick={() => {
                                    setError(null);
                                    setStep("connect");
                                }}
                                className="text-sm text-primary hover:underline"
                            >
                                {tW("tryAgain")}
                            </button>
                            <button
                                type="button"
                                onClick={handleCancel}
                                className="block mx-auto text-sm text-muted-foreground hover:text-foreground"
                            >
                                {tW("cancel")}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

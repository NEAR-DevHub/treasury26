import type { ConnectorAction } from "./utils/action";
import type { SignInParams } from "./utils/types";

const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 700;
const POLL_INTERVAL = 300;
// Cadence for polling the backend while a created proposal awaits treasury
// approval; matches the wallet page's own polling.
const APPROVAL_POLL_INTERVAL = 10_000;

const TREZU_URLS: Record<string, string> = {
    mainnet: "https://trezu.app",
    // Only mainnet is supported, but we keep it here just in case
    // testnet: "https://trezu.app",
};

const BACKEND_URLS: Record<string, string> = {
    mainnet: "https://api.trezu.app",
    // Only mainnet is supported, but we keep it here just in case
    // testnet: "https://api.testenv.trezu.app",
};

// Built-in btoa() JS function fails on UTF8 inputs.
// `Buffer` polyfill brings +30kb to the minified bundle.
// https://stackoverflow.com/questions/23223718/failed-to-execute-btoa-on-window-the-string-to-be-encoded-contains-characte
function toBase64(txt: string): string {
    const uint8Array = new TextEncoder().encode(txt);
    let binary = "";

    for (let i = 0; i < uint8Array.length; ++i) {
        binary += String.fromCharCode(uint8Array[i]);
    }

    return btoa(binary);
}

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Request failed with status ${res.status}`);
    }
    return res.json();
}

// Final execution outcome in the NEAR `tx` RPC result shape, served by the
// Trezu backend so the connector never talks to an RPC node directly.
async function txStatus(
    backendUrl: string,
    txHash: string,
    signerId: string,
): Promise<any> {
    return fetchJson(
        `${backendUrl}/api/wallet-adapter/tx-status/${txHash}/${signerId}`,
    );
}

interface WalletMessage {
    type: string;
    status?: "success" | "failure";
    accountId?: string;
    publicKey?: string;
    transactionHashes?: string;
    errorMessage?: string;
    daoId?: string;
    proposalIds?: number[];
    [key: string]: unknown;
}

interface PendingProposals {
    daoId: string;
    proposalIds: number[];
}

interface Settle<T> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

class TrezuWalletConnector {
    walletUrl: string;
    signedAccountId: string;
    network: string;

    constructor(walletUrl: string, network: string) {
        this.walletUrl = walletUrl;
        this.signedAccountId =
            window.localStorage.getItem("trezu:signedAccountId") || "";
        this.network = network;
    }

    getAccountId(): string {
        return this.signedAccountId;
    }

    isSignedIn(): boolean {
        return !!this.signedAccountId;
    }

    signOut(): void {
        this.signedAccountId = "";
        window.localStorage.removeItem("trezu:signedAccountId");
    }

    private backendUrl(): string {
        return BACKEND_URLS[this.network] || BACKEND_URLS.mainnet;
    }

    async requestSignIn(): Promise<
        Array<{ accountId: string; publicKey: string }>
    > {
        const url = new URL(`${this.walletUrl}/wallet`);
        url.searchParams.set("action", "sign_in");
        url.searchParams.set("network", this.network);
        url.searchParams.set("callbackUrl", window.selector.location);

        return await this.handlePopup(url.toString(), (data) => {
            const accountId = data.accountId;
            if (accountId) {
                this.signedAccountId = accountId;
                window.localStorage.setItem("trezu:signedAccountId", accountId);
                return [{ accountId, publicKey: data.publicKey || "" }];
            }
            throw new Error("Invalid response from Trezu Wallet");
        });
    }

    async signAndSendTransactions(
        transactions: Array<{ receiverId: string; actions: ConnectorAction[] }>,
    ): Promise<any[]> {
        const url = new URL(`${this.walletUrl}/wallet`);
        url.searchParams.set("action", "sign_transactions");
        url.searchParams.set("network", this.network);
        url.searchParams.set("callbackUrl", window.selector.location);
        url.searchParams.set(
            "transactions",
            toBase64(JSON.stringify(transactions)),
        );
        url.searchParams.set("signerId", this.signedAccountId);

        return await this.handlePopup(
            url.toString(),
            async (data) => {
                if (data.transactionHashes) {
                    const hashes = data.transactionHashes.split(",");
                    return await Promise.all(
                        hashes.map((hash: string) =>
                            txStatus(
                                this.backendUrl(),
                                hash,
                                this.signedAccountId,
                            ),
                        ),
                    );
                }
                return [];
            },
            (pending, settle) => this.pollPendingProposals(pending, settle),
        );
    }

    async signAndSendTransaction(params: {
        receiverId: string;
        actions: ConnectorAction[];
    }): Promise<any> {
        const results = await this.signAndSendTransactions([params]);
        return results[0];
    }

    /**
     * Poll the backend until every pending proposal is approved (settles with
     * the execution outcomes) or any is rejected (settles with an error).
     * Returns a cleanup that stops the polling.
     */
    private pollPendingProposals(
        pending: PendingProposals,
        settle: Settle<any[]>,
    ): () => void {
        const backendUrl = this.backendUrl();
        let checking = false;

        const check = async () => {
            if (checking) return;
            checking = true;
            try {
                // The execution-transaction lookup requires a date window; the
                // proposals were created in this session, so a generous fixed
                // window around now is enough.
                const now = Date.now();
                const dayMs = 24 * 60 * 60 * 1000;
                const afterDate = new Date(now - 30 * dayMs)
                    .toISOString()
                    .split("T")[0];
                const beforeDate = new Date(now + 2 * dayMs)
                    .toISOString()
                    .split("T")[0];

                const txHashes: string[] = [];
                for (const proposalId of pending.proposalIds) {
                    const proposal = await fetchJson(
                        `${backendUrl}/api/wallet-adapter/proposal/${pending.daoId}/${proposalId}`,
                    );
                    if (!proposal || proposal.status === "InProgress") {
                        return;
                    }
                    if (proposal.status !== "Approved") {
                        settle.reject(
                            new Error(
                                `Proposal ${proposalId} was ${proposal.status.toLowerCase()}`,
                            ),
                        );
                        return;
                    }

                    const tx = await fetchJson(
                        `${backendUrl}/api/wallet-adapter/proposal/${pending.daoId}/${proposalId}/tx` +
                            `?action=VoteApprove&afterDate=${afterDate}&beforeDate=${beforeDate}`,
                    );
                    if (!tx || !tx.transaction_hash) {
                        // Approved but not indexed yet — keep polling.
                        return;
                    }
                    txHashes.push(tx.transaction_hash);
                }

                const outcomes = await Promise.all(
                    txHashes.map((hash) =>
                        txStatus(backendUrl, hash, this.signedAccountId),
                    ),
                );
                settle.resolve(outcomes);
            } catch {
                // Transient backend failure — keep polling.
            } finally {
                checking = false;
            }
        };

        const intervalId = setInterval(
            () => void check(),
            APPROVAL_POLL_INTERVAL,
        );
        return () => clearInterval(intervalId);
    }

    private async handlePopup<T>(
        url: string,
        callback: (result: WalletMessage) => T | Promise<T>,
        onPending?: (
            pending: PendingProposals,
            settle: Settle<T>,
        ) => () => void,
    ): Promise<T> {
        const screenWidth = window.innerWidth || screen.width;
        const screenHeight = window.innerHeight || screen.height;
        const left = (screenWidth - DEFAULT_POPUP_WIDTH) / 2;
        const top = (screenHeight - DEFAULT_POPUP_HEIGHT) / 2;

        const childWindow = window.selector.open(
            url,
            "TrezuWallet",
            `width=${DEFAULT_POPUP_WIDTH},height=${DEFAULT_POPUP_HEIGHT},top=${top},left=${left}`,
        );

        const id = await childWindow.windowIdPromise;
        if (!id) {
            // The popup was blocked: ask for an explicit approval so the next
            // open() runs inside that click's user gesture.
            await window.selector.ui.whenApprove({
                title: "Request action",
                button: "Open Trezu Wallet",
            });
            return await this.handlePopup(url, callback, onPending);
        }

        return new Promise<T>((resolvePromise, rejectPromise) => {
            let intervalId: ReturnType<typeof setInterval> | undefined;
            let stopPendingPoll: (() => void) | undefined;
            let pendingReceived = false;
            let settled = false;

            const cleanup = () => {
                window.removeEventListener("message", handler);
                if (intervalId !== undefined) {
                    clearInterval(intervalId);
                }
                stopPendingPoll?.();
            };

            const settle = (finish: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                finish();
            };

            const handler = (event: MessageEvent) => {
                const message = event.data as WalletMessage;
                if (
                    !message ||
                    !message.type ||
                    !message.type.startsWith("trezu:")
                )
                    return;

                if (
                    message.type === "trezu:pending" &&
                    onPending &&
                    !pendingReceived &&
                    typeof message.daoId === "string" &&
                    Array.isArray(message.proposalIds) &&
                    message.proposalIds.length > 0
                ) {
                    // The proposals now exist on-chain: approval can complete
                    // without the popup, so closing it is no longer a failure
                    // and the connector tracks the outcome itself.
                    pendingReceived = true;
                    stopPendingPoll = onPending(
                        {
                            daoId: message.daoId,
                            proposalIds: message.proposalIds,
                        },
                        {
                            resolve: (value) =>
                                settle(() => resolvePromise(value)),
                            reject: (error) =>
                                settle(() => rejectPromise(error)),
                        },
                    );
                    return;
                }

                if (message.type === "trezu:result") {
                    if (message.status === "success") {
                        settle(() => {
                            childWindow.close();
                            Promise.resolve(callback(message)).then(
                                resolvePromise,
                                rejectPromise,
                            );
                        });
                    } else if (message.status === "failure") {
                        settle(() => {
                            childWindow.close();
                            rejectPromise(
                                new Error(
                                    message.errorMessage || "Operation failed",
                                ),
                            );
                        });
                    }
                }
            };

            window.addEventListener("message", handler);

            intervalId = setInterval(() => {
                if (childWindow.closed) {
                    clearInterval(intervalId);
                    intervalId = undefined;
                    // Once proposals are pending the popup may be closed
                    // freely; the backend polling keeps driving the result.
                    if (!pendingReceived) {
                        settle(() =>
                            rejectPromise(new Error("User closed the window")),
                        );
                    }
                }
            }, POLL_INTERVAL);
        });
    }
}

const wallets: Record<string, TrezuWalletConnector> = {
    mainnet: new TrezuWalletConnector(TREZU_URLS.mainnet, "mainnet"),
};

const TrezuWallet = async () => {
    const getWallet = (network: string): TrezuWalletConnector => {
        const wallet = wallets[network];
        if (!wallet) {
            throw new Error(`Unsupported network: ${network}`);
        }
        return wallet;
    };

    const getAccounts = async (network: string) => {
        const wallet = getWallet(network);

        if (!wallet.isSignedIn()) {
            return [];
        }

        const accountId = wallet.getAccountId();

        if (!accountId) {
            return [];
        }

        return [{ accountId, publicKey: "" }];
    };

    return {
        async signIn({ network }: SignInParams) {
            const wallet = getWallet(network);
            if (!wallet.isSignedIn()) {
                await wallet.requestSignIn();
            }
            return getAccounts(network);
        },

        async signOut({ network }: { network: string }) {
            const wallet = getWallet(network);
            wallet.signOut();
        },

        async getAccounts({ network }: { network: string }) {
            return getAccounts(network);
        },

        async verifyOwner() {
            throw new Error("Method not supported by Trezu Wallet");
        },

        async signMessage() {
            throw new Error("Method not supported by Trezu Wallet");
        },

        async signAndSendTransaction({
            receiverId,
            actions,
            network,
        }: {
            receiverId: string;
            actions: ConnectorAction[];
            network: string;
        }) {
            const wallet = getWallet(network);
            if (!wallet.isSignedIn()) throw new Error("Wallet not signed in");
            return wallet.signAndSendTransaction({ receiverId, actions });
        },

        async signAndSendTransactions({
            transactions,
            network,
        }: {
            transactions: { receiverId: string; actions: ConnectorAction[] }[];
            network: string;
        }) {
            const wallet = getWallet(network);
            if (!wallet.isSignedIn()) throw new Error("Wallet not signed in");
            return wallet.signAndSendTransactions(transactions);
        },
    };
};

TrezuWallet().then((wallet) => {
    window.selector.ready(wallet);
});

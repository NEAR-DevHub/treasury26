"use client";

import { create } from "zustand";
import { NearConnector, SignAndSendTransactionsParams, SignedMessage } from "@hot-labs/near-connect";
import { NEAR_TREASURY_CONFIG } from "@/constants/config";
import { EventMap } from "@hot-labs/near-connect/build/types/wallet-events";
import { FinalExecutionOutcome } from "@hot-labs/near-connect/build/types/wallet";

interface NearStore {
    connector: NearConnector | null;
    accountId: string | null;
    isInitializing: boolean;
    init: () => Promise<NearConnector | undefined>;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    signMessage: (message: string) => Promise<{ signatureData: SignedMessage; signedData: string }>;
    signAndSendTransactions: (params: SignAndSendTransactionsParams) => Promise<Array<FinalExecutionOutcome>>;
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
    } = useNearStore();

    return {
        connector,
        accountId,
        isInitializing,
        connect,
        disconnect,
        signMessage,
        signAndSendTransactions,
    };
};

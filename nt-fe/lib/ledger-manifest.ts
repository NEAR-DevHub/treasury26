/**
 * Ledger Hardware Wallet Manifest
 * Configuration for registering Ledger wallet with hot-connect
 */

export const ledgerWalletManifest = {
    id: "ledger",
    name: "Ledger",
    // Official Ledger logo
    icon: "/ledger-icon.jpeg",
    description: "Secure hardware wallet for NEAR Protocol",
    website: "https://www.ledger.com",
    version: "1.0.0",
    executor: "/ledger-executor.js", // Relative URL served from public folder
    type: "sandbox" as const,
    platform: [],
    features: {
        signMessage: true,
        signTransaction: true,
        signInWithoutAddKey: false,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        mainnet: true,
        testnet: true,
    },
    permissions: {
        storage: true,
        usb: true, // Required for Ledger USB
        hid: true, // Required for WebHID protocol
        allowsOpen: [],
    },
};

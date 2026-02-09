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
        signDelegateAction: true,
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

export const meteorWalletManifest = {
    id: "meteor-wallet-latest",
    name: "Meteor Wallet",
    icon: "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/meteor-logo-svg.svg",
    description:
        "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
    website: "https://meteorwallet.app/",
    version: "1.1.0",
    executor:
        "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/data-storage/storage/meteor-near-connect-latest.js",
    type: "sandbox" as const,

    features: {
        signMessage: true,
        signTransaction: false,
        signInWithoutAddKey: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signDelegateAction: true,
        mainnet: true,
        testnet: true,
    },

    platform: [
        "https://wallet.meteorwallet.app",
        "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
    ],
    permissions: {
        storage: true,
        allowsOpen: [
            "https://chromewebstore.google.com",
            "https://wallet.meteorwallet.app",
            "https://meteorwallet.app",
        ],
        external: ["meteorCom", "meteorComV2"],
    },
};

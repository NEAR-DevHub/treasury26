export const WALLET_IDS = {
    NEAR: "near",
    LEDGER: "ledger",
    EVM: "walletcontract-eip712",
    PASSKEY: "passkey",
    METEOR: "meteor-wallet",
    INTEAR: "intear-wallet",
    NEAR_MOBILE: "near-mobile",
    NEAR_CLI: "near-cli",
    PHANTOM: "phantom",
} as const;

export type WalletId = (typeof WALLET_IDS)[keyof typeof WALLET_IDS];

export const MANIFEST_WALLET_IDS = {
    LEDGER: WALLET_IDS.LEDGER,
    METEOR: WALLET_IDS.METEOR,
    INTEAR: WALLET_IDS.INTEAR,
    NEAR_MOBILE: WALLET_IDS.NEAR_MOBILE,
    NEAR_CLI: WALLET_IDS.NEAR_CLI,
    EVM: WALLET_IDS.EVM,
} as const;

export type HotLabsManifestWalletId =
    (typeof MANIFEST_WALLET_IDS)[keyof typeof MANIFEST_WALLET_IDS];

/**
 * Maps wallet-selector ids to warnings admin login slots. The NEAR group is a
 * container (it opens a modal of NEAR wallet choices), so it has no slot of its
 * own — only its inner choices and the direct wallets are targetable.
 */
export const WALLET_LOGIN_SLOTS: Partial<Record<WalletId, string>> = {
    [WALLET_IDS.LEDGER]: "login.wallet.ledger",
    [WALLET_IDS.EVM]: "login.wallet.evm",
    [WALLET_IDS.PASSKEY]: "login.wallet.passkey",
    [WALLET_IDS.METEOR]: "login.wallet.meteor",
    [WALLET_IDS.INTEAR]: "login.wallet.intear",
    [WALLET_IDS.NEAR_MOBILE]: "login.wallet.near-mobile",
    [WALLET_IDS.NEAR_CLI]: "login.wallet.near-cli",
    [WALLET_IDS.PHANTOM]: "login.wallet.phantom",
};

export const MANIFEST_WALLET_ID_BY_OPTION: Partial<
    Record<WalletId, HotLabsManifestWalletId>
> = {
    [WALLET_IDS.LEDGER]: MANIFEST_WALLET_IDS.LEDGER,
    [WALLET_IDS.METEOR]: MANIFEST_WALLET_IDS.METEOR,
    [WALLET_IDS.INTEAR]: MANIFEST_WALLET_IDS.INTEAR,
    [WALLET_IDS.NEAR_MOBILE]: MANIFEST_WALLET_IDS.NEAR_MOBILE,
    [WALLET_IDS.NEAR_CLI]: MANIFEST_WALLET_IDS.NEAR_CLI,
    [WALLET_IDS.EVM]: MANIFEST_WALLET_IDS.EVM,
};

export const WALLET_GROUP_BY_ID: Partial<Record<WalletId, WalletId>> = {
    [WALLET_IDS.NEAR]: WALLET_IDS.NEAR,
    [WALLET_IDS.EVM]: WALLET_IDS.EVM,
    [WALLET_IDS.LEDGER]: WALLET_IDS.LEDGER,
    [WALLET_IDS.PASSKEY]: WALLET_IDS.PASSKEY,
    [WALLET_IDS.PHANTOM]: WALLET_IDS.PHANTOM,
};

/** Wallets triggered directly by id through NearConnect (not via the NEAR popup). */
export const DIRECT_TRIGGER_WALLET_IDS = [
    WALLET_IDS.LEDGER,
    WALLET_IDS.EVM,
] as const satisfies readonly WalletId[];

export function isDirectTriggerWallet(walletId: string): boolean {
    return DIRECT_TRIGGER_WALLET_IDS.some((id) => id === walletId);
}

export const LAST_USED_WALLET_STORAGE_KEY = "trezu:last-used-wallet";
export const SELECTED_WALLET_STORAGE_KEY = "selected-wallet";
export const TARGET_WALLET_STORAGE_KEY = "trezu:target-wallet";

export type WalletOption = {
    id: WalletId;
    label: string;
    imgSrc?: string;
    imageClassName?: string;
    secondaryIconSrc?: string;
    tertiaryIconSrc?: string;
    isPopular?: boolean;
    recentGroupAlias?: WalletId;
    supported: boolean;
};

export const WALLET_OPTIONS: WalletOption[] = [
    {
        id: WALLET_IDS.NEAR,
        label: "NEAR Wallets",
        imgSrc: "/near.com.svg",
        isPopular: true,
        supported: true,
    },
    {
        id: WALLET_IDS.LEDGER,
        label: "Ledger",
        imgSrc: "/wallets/ledger.svg",
        supported: true,
    },
    {
        id: WALLET_IDS.PASSKEY,
        label: "Passkey",
        supported: false,
    },
    {
        id: WALLET_IDS.PHANTOM,
        label: "Phantom Wallet",
        imgSrc: "/icons/phantom.svg",
        supported: false,
    },
    {
        id: WALLET_IDS.EVM,
        label: "EVM Wallets",
        imgSrc: "/icons/metamask.svg",
        secondaryIconSrc: "/icons/fireblocks.svg",
        tertiaryIconSrc: "/icons/binance-web3.svg",
        supported: true,
    },
];

export const NEAR_WALLET_CHOICES: WalletOption[] = [
    {
        id: WALLET_IDS.METEOR,
        label: "Meteor Wallet",
        imgSrc: "/icons/meteor.svg",
        supported: true,
        isPopular: true,
        recentGroupAlias: WALLET_IDS.NEAR,
    },
    {
        id: WALLET_IDS.INTEAR,
        label: "Intear Wallet",
        imgSrc: "/icons/intear.svg",
        supported: true,
    },
    {
        id: WALLET_IDS.NEAR_MOBILE,
        label: "NEAR Mobile",
        imgSrc: "/icons/near-mobile.svg",
        supported: true,
    },
    {
        id: WALLET_IDS.NEAR_CLI,
        label: "NEAR CLI",
        imgSrc: "/icons/near-cli.svg",
        supported: true,
    },
];

export function getWalletLoginSlot(walletId: string): string {
    return (
        WALLET_LOGIN_SLOTS[walletId as WalletId] ?? `login.wallet.${walletId}`
    );
}

export function getWalletGroup(walletId: string | null): WalletId | null {
    if (!walletId) return null;

    if (walletId.includes("phantom")) return WALLET_IDS.PHANTOM;
    if (walletId.includes(WALLET_IDS.EVM)) return WALLET_IDS.EVM;
    const knownGroup = WALLET_GROUP_BY_ID[walletId as WalletId];
    if (knownGroup) return knownGroup;
    return WALLET_IDS.NEAR;
}

export function resolveManifestWalletId(
    walletId: WalletId,
): WalletId | undefined {
    return MANIFEST_WALLET_ID_BY_OPTION[walletId];
}

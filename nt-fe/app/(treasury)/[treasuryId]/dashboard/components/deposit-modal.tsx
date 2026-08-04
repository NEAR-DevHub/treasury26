"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { InputBlock } from "@/components/input-block";
import { getNetworkDisplayName } from "@/components/token-display";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { SlotWarning, WarningMessage } from "@/components/warning-message";
import {
    NEAR_COM_DIRECT_NETWORK_ID,
    NEAR_NETWORK_ID,
} from "@/constants/network-ids";
import { NEAR_CHAIN_ICONS } from "@/constants/token";
import {
    type AggregatedAsset,
    DEFAULT_ASSETS_QUERY,
    useAggregatedTokens,
    useAssets,
} from "@/hooks/use-assets";
import { type BridgeNetwork, useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { usePopularAssetsByActivity } from "@/hooks/use-treasury-queries";
import {
    isTokenOrNetworkScopedWarning,
    useScopedSlotWarning,
} from "@/hooks/use-warnings";
import { trackEvent } from "@/lib/analytics";
import Big from "@/lib/big";
import { fetchDepositAddress } from "@/lib/bridge-api";
import { getNetworkDisplayCaseClass } from "@/lib/intents-network";
import { pickDefaultDepositAsset } from "@/lib/pick-default-token";
import {
    canonicalizeTokenIdForMatch,
    cn,
    formatBalance,
    formatCurrencyWithSubCent,
    formatSmartAmount,
    normalizeNearAssetId,
} from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { DepositAckPanel } from "./deposit/deposit-ack-panel";
import {
    DepositAddressSkeleton,
    DepositAddressView,
} from "./deposit/deposit-address-view";
import { DepositConfidentialSourceTabs } from "./deposit/deposit-confidential-source-tabs";
import { DepositGuestBanner } from "./deposit/deposit-guest-banner";
import {
    buildConfidentialOriginNotices,
    buildPublicTreasuryNotices,
    buildPublicWalletOneTimeNotices,
} from "./deposit/deposit-notices";
import { DepositOptionIcon } from "./deposit/deposit-option-icon";
import { DepositSourceCards } from "./deposit/deposit-source-cards";
import { buildDepositTransferPath } from "./deposit/deposit-transfer-url";
import type {
    ConfidentialOrigin,
    DepositInfo,
    DepositSource,
    DepositStep,
    SelectOption,
} from "./deposit/deposit-types";
import { SelectModal } from "./select-modal";

interface DepositPageContentProps {
    prefillTokenId?: string;
    prefillNetworkId?: string;
}

const assetSchema = z.object({
    id: z.string(),
    name: z.string(),
    icon: z.string(),
    gradient: z.string().optional(),
    networks: z.array(z.any()).optional(),
});

const networkSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    symbol: z.string().optional(),
    icon: z.string(),
    gradient: z.string().optional(),
    chainId: z.string().optional(),
});

function buildDepositFormSchema(messages: {
    selectAsset: string;
    selectNetwork: string;
}) {
    return z.object({
        asset: assetSchema.nullable().refine((val) => val !== null, {
            message: messages.selectAsset,
        }),
        network: networkSchema.nullable().refine((val) => val !== null, {
            message: messages.selectNetwork,
        }),
    });
}

type Asset = z.infer<typeof assetSchema>;
type Network = z.infer<typeof networkSchema>;

type DepositFormValues = {
    asset: Asset | null;
    network: Network | null;
};

interface NetworkBalanceDisplay {
    amount: string;
    amountUSD: number;
}

const STABLE_EMPTY_ARRAY: never[] = [];
export const SINGLE_USE_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;

type AssetSection = {
    title: string;
    options: SelectOption[];
    display?: "list" | "chips";
};

interface DepositAssetsState {
    allAssets: SelectOption[];
    assetSections: AssetSection[];
    assetBalanceMap: Map<string, { balance: string; balanceUSD: number }>;
    assetNetworksMap: Map<string, SelectOption[]>;
    networkBalancesByAsset: Map<string, Map<string, NetworkBalanceDisplay>>;
    filteredNetworks: SelectOption[];
    selectedNetworkBalances: Map<string, NetworkBalanceDisplay>;
}

const initialDepositAssetsState: DepositAssetsState = {
    allAssets: [],
    assetSections: [],
    assetBalanceMap: new Map(),
    assetNetworksMap: new Map(),
    networkBalancesByAsset: new Map(),
    filteredNetworks: [],
    selectedNetworkBalances: new Map(),
};

type DepositAssetsAction =
    | { type: "LOAD_DEPOSIT_ASSETS"; payload: DepositAssetsState }
    | {
          type: "SELECT_ASSET";
          payload: {
              filteredNetworks: SelectOption[];
              selectedNetworkBalances: Map<string, NetworkBalanceDisplay>;
          };
      };

function depositAssetsReducer(
    state: DepositAssetsState,
    action: DepositAssetsAction,
): DepositAssetsState {
    switch (action.type) {
        case "LOAD_DEPOSIT_ASSETS":
            return action.payload;
        case "SELECT_ASSET":
            return { ...state, ...action.payload };
        default:
            return state;
    }
}

function toNetworkOption(network: BridgeNetwork): SelectOption {
    const iconUrl = network.chainIcons?.icon ?? null;
    return {
        id: network.id,
        name: network.name,
        symbol: network.symbol,
        icon: iconUrl || network.name.charAt(0),
        gradient: "bg-linear-to-br from-green-500 to-teal-500",
        chainId: network.chainId,
        supportsPublicNearDepositSource:
            network.supportsPublicNearDepositSource,
    };
}

function buildNetworkBalanceMap(
    assetId: string,
    bridgeNetworks: BridgeNetwork[],
    ownedTreasuryAssetsById: Map<string, AggregatedAsset>,
): Map<string, NetworkBalanceDisplay> {
    const balances = new Map<string, NetworkBalanceDisplay>();
    const ownedAsset = ownedTreasuryAssetsById.get(assetId.toLowerCase());

    if (!ownedAsset) return balances;

    for (const bridgeNetwork of bridgeNetworks) {
        const normalizedBridgeId = normalizeNearAssetId(bridgeNetwork.id);
        const byContractId = ownedAsset.networks.filter(
            (network) =>
                normalizeNearAssetId(network.contractId) === normalizedBridgeId,
        );

        const bridgeNetworkName = bridgeNetwork.name.toLowerCase();
        const includeAllNearResidencies =
            assetId.toLowerCase() === NEAR_NETWORK_ID &&
            bridgeNetworkName === NEAR_NETWORK_ID;

        const chainMatches = ownedAsset.networks.filter(
            (network) => network.network.toLowerCase() === bridgeNetworkName,
        );

        const fallbackChainMatches = ownedAsset.networks.filter(
            (network) =>
                !network.contractId &&
                network.network.toLowerCase() === bridgeNetworkName,
        );

        const matches = includeAllNearResidencies
            ? chainMatches
            : byContractId.length > 0
              ? byContractId
              : fallbackChainMatches;

        if (matches.length === 0) continue;

        const amount = matches
            .reduce((sum, network) => {
                return sum.add(
                    Big(network.availableBalanceRaw).div(
                        Big(10).pow(network.decimals),
                    ),
                );
            }, Big(0))
            .toString();
        const amountUSD = matches.reduce(
            (sum, network) => sum + network.availableBalanceUSD,
            0,
        );

        if (Big(amount).gt(0)) {
            balances.set(bridgeNetwork.id, {
                amount,
                amountUSD,
            });
        }
    }

    return balances;
}

function renderBalance(amount: number | string, amountUSD: number) {
    const normalizedAmount = amount.toString();
    if (!Big(normalizedAmount).gt(0)) {
        return null;
    }
    const normalizedUsd = Number.isFinite(amountUSD)
        ? formatCurrencyWithSubCent(amountUSD)
        : formatCurrencyWithSubCent(0);

    return (
        <div className="flex flex-col items-end">
            <span className="font-semibold">
                {formatSmartAmount(normalizedAmount)}
            </span>
            <span className="text-sm text-muted-foreground">
                ≈{normalizedUsd}
            </span>
        </div>
    );
}

function isNearNetworkId(chainIdOrId: string | undefined): boolean {
    return (chainIdOrId ?? "").toLowerCase().includes(NEAR_NETWORK_ID);
}

export function DepositModal({
    prefillTokenId,
    prefillNetworkId,
}: DepositPageContentProps) {
    const t = useTranslations("depositModal");
    const depositFormSchema = useMemo(
        () =>
            buildDepositFormSchema({
                selectAsset: t("validation.selectAsset"),
                selectNetwork: t("validation.selectNetwork"),
            }),
        [t],
    );
    const { treasuryId, isConfidential, isGuestTreasury, config } =
        useTreasury();
    const { accountId } = useNear();
    const showGuestBanner = isConfidential && (isGuestTreasury || !accountId);
    const router = useRouter();
    const {
        data: { tokens: treasuryAssets } = { tokens: STABLE_EMPTY_ARRAY },
        isPending: isAssetsPending,
    } = useAssets(treasuryId, DEFAULT_ASSETS_QUERY);
    const aggregatedTreasuryTokens = useAggregatedTokens(treasuryAssets);
    const latestAddressRequestRef = useRef(0);
    const form = useForm<DepositFormValues>({
        resolver: zodResolver(depositFormSchema),
        mode: "onChange",
        defaultValues: {
            asset: null,
            network: null,
        },
    });

    const [step, setStep] = useState<DepositStep>("select");
    const [depositSource, setDepositSource] =
        useState<DepositSource>("public_wallet");
    const [confidentialOrigin, setConfidentialOrigin] =
        useState<ConfidentialOrigin>("trezu");
    const [hasAcknowledged, setHasAcknowledged] = useState(false);
    const [modalType, setModalType] = useState<"asset" | "network" | null>(
        null,
    );
    /** Successfully resolved public asset+network key (skip refetch on address). */
    const lastPublicAutoFetchKeyRef = useRef<string | null>(null);
    /** Failed public asset+network key (block auto-advance until selection/login changes). */
    const failedPublicFetchKeyRef = useRef<string | null>(null);
    const [depositAssetsState, dispatchDepositAssets] = useReducer(
        depositAssetsReducer,
        initialDepositAssetsState,
    );
    const {
        allAssets,
        assetSections,
        assetBalanceMap,
        assetNetworksMap,
        networkBalancesByAsset,
        filteredNetworks,
        selectedNetworkBalances,
    } = depositAssetsState;
    const [depositInfo, setDepositInfo] = useState<DepositInfo | null>(null);
    const [isLoadingAddress, setIsLoadingAddress] = useState(false);
    const [singleUseExpiresAt, setSingleUseExpiresAt] = useState<number | null>(
        null,
    );
    const previousTreasuryIdRef = useRef(treasuryId);
    const { data: popularAssets = STABLE_EMPTY_ARRAY } =
        usePopularAssetsByActivity();

    const selectedAsset = form.watch("asset");
    const selectedNetwork = form.watch("network");
    const {
        warning: depositScopeWarning,
        blocked: depositBlocked,
        scopedMessage: depositScopedMessage,
    } = useScopedSlotWarning(
        "deposit",
        selectedAsset?.id,
        selectedNetwork?.name,
    );
    const depositTokenNetworkScoped =
        isTokenOrNetworkScopedWarning(depositScopeWarning);
    const {
        data: bridgeAssets = STABLE_EMPTY_ARRAY,
        isLoading: isLoadingAssets,
    } = useBridgeTokens(true, { includeNearNetwork: true });
    const depositSelectorsDisabled =
        isLoadingAssets || (depositBlocked && !depositTokenNetworkScoped);

    const invalidatePendingAddressRequest = useCallback(() => {
        latestAddressRequestRef.current += 1;
        setIsLoadingAddress(false);
    }, []);

    // Switching treasury keeps the same deposit route; reset back to select.
    useEffect(() => {
        if (previousTreasuryIdRef.current === treasuryId) return;
        previousTreasuryIdRef.current = treasuryId;

        invalidatePendingAddressRequest();
        form.reset({ asset: null, network: null });
        setStep("select");
        setDepositSource("public_wallet");
        setConfidentialOrigin("trezu");
        setHasAcknowledged(false);
        setModalType(null);
        setDepositInfo(null);
        setSingleUseExpiresAt(null);
        lastPublicAutoFetchKeyRef.current = null;
        dispatchDepositAssets({
            type: "SELECT_ASSET",
            payload: {
                filteredNetworks: [],
                selectedNetworkBalances: new Map(),
            },
        });
    }, [treasuryId, form, invalidatePendingAddressRequest]);

    useEffect(() => {
        if (selectedAsset && selectedNetwork) {
            trackEvent("deposit-asset-and-network-selected", {
                treasury_id: treasuryId!,
                asset_id: selectedAsset.id,
                asset_name: selectedAsset.name,
                network_id: selectedNetwork.id,
                network_name: selectedNetwork.name,
            });
        }
    }, [selectedAsset?.id, selectedNetwork?.id, treasuryId]);

    const selectedBridgeNetwork = useMemo(() => {
        if (!selectedAsset || !selectedNetwork) return null;

        const bridgeAsset = bridgeAssets.find(
            (asset) => asset.id === selectedAsset.id,
        );

        if (!bridgeAsset) return null;

        return bridgeAsset.networks.find(
            (network) => network.id === selectedNetwork.id,
        );
    }, [selectedAsset, selectedNetwork, bridgeAssets]);

    const isNearNetworkSelected = isNearNetworkId(
        selectedNetwork?.chainId ?? selectedNetwork?.id,
    );
    const isConfidentialNearFallbackOnly =
        isConfidential &&
        isNearNetworkSelected &&
        selectedBridgeNetwork?.supportsPublicNearDepositSource === false;

    // When NEAR public deposit is unsupported, force confidential-user source.
    useEffect(() => {
        if (
            isConfidentialNearFallbackOnly &&
            depositSource !== "confidential_user"
        ) {
            setDepositSource("confidential_user");
            setHasAcknowledged(false);
            setStep("select");
            setDepositInfo(null);
            setSingleUseExpiresAt(null);
        }
    }, [isConfidentialNearFallbackOnly, depositSource]);

    const networkSections = useMemo(() => {
        const withAssets: SelectOption[] = [];
        const supportedNetworks: SelectOption[] = [];

        for (const network of filteredNetworks) {
            const balance = selectedNetworkBalances.get(network.id);
            const hasBalance = !!balance && Big(balance.amount).gt(0);
            if (hasBalance) {
                withAssets.push(network);
            } else {
                supportedNetworks.push(network);
            }
        }

        withAssets.sort((a, b) => {
            const aUSD = selectedNetworkBalances.get(a.id)?.amountUSD || 0;
            const bUSD = selectedNetworkBalances.get(b.id)?.amountUSD || 0;
            if (aUSD !== bUSD) return bUSD - aUSD;
            return a.name.localeCompare(b.name);
        });

        supportedNetworks.sort((a, b) => {
            if (a.id === NEAR_COM_DIRECT_NETWORK_ID) return -1;
            if (b.id === NEAR_COM_DIRECT_NETWORK_ID) return 1;
            return a.name.localeCompare(b.name);
        });

        if (withAssets.length === 0) {
            return [
                {
                    title: t("sections.supportedNetworks"),
                    options: supportedNetworks,
                },
            ];
        }

        return [
            {
                title: t("sections.networksWithAssets"),
                options: withAssets,
            },
            {
                title: t("sections.supportedNetworks"),
                options: supportedNetworks,
            },
        ];
    }, [filteredNetworks, selectedNetworkBalances, t]);

    useEffect(() => {
        if (!bridgeAssets.length) return;

        form.clearErrors();

        const otherAsset: SelectOption = {
            id: "other",
            name: t("otherAssetName"),
            icon: "O",
            gradient: "bg-brand-blue",
            networks: [
                {
                    id: "other:near",
                    name: "Near",
                    symbol: "Other",
                    chainIcons: NEAR_CHAIN_ICONS,
                    chainId: "near:mainnet",
                    decimals: 24,
                },
            ],
        };

        const newAssetNetworksMap = new Map<string, SelectOption[]>();
        const networkBalancesByAssetId = new Map<
            string,
            Map<string, NetworkBalanceDisplay>
        >();
        const ownedTreasuryAssetsById = new Map(
            aggregatedTreasuryTokens.map((asset) => [
                asset.id.toLowerCase(),
                asset,
            ]),
        );
        const assetBalancesById = new Map<
            string,
            { balance: string; balanceUSD: number }
        >();

        const yourAssets: SelectOption[] = [];
        const otherAssets: SelectOption[] = [];

        for (const asset of bridgeAssets) {
            const networks = asset.networks.map(toNetworkOption);
            newAssetNetworksMap.set(asset.id, networks);
            networkBalancesByAssetId.set(
                asset.id,
                buildNetworkBalanceMap(
                    asset.id,
                    asset.networks,
                    ownedTreasuryAssetsById,
                ),
            );

            const normalizedId = asset.id.toLowerCase();
            const ownedAsset = ownedTreasuryAssetsById.get(normalizedId);
            const selectOption: SelectOption = {
                id: asset.id,
                name: asset.name,
                symbol: asset.networks[0]?.symbol,
                icon: asset.icon,
                gradient: "bg-brand-blue",
                networks: asset.networks,
            };

            if (ownedAsset) {
                yourAssets.push(selectOption);
                assetBalancesById.set(asset.id, {
                    balance: ownedAsset.availableTotalBalance.toString(),
                    balanceUSD: ownedAsset.availableTotalBalanceUSD,
                });
                continue;
            }

            otherAssets.push(selectOption);
        }

        yourAssets.sort((a, b) => {
            const aUSD = assetBalancesById.get(a.id)?.balanceUSD || 0;
            const bUSD = assetBalancesById.get(b.id)?.balanceUSD || 0;
            return bUSD - aUSD;
        });
        otherAssets.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        const formattedAssets: SelectOption[] = [...yourAssets, ...otherAssets];

        if (!isConfidential) {
            formattedAssets.push(otherAsset);
            const otherNetworks = (otherAsset.networks ??
                []) as BridgeNetwork[];
            newAssetNetworksMap.set(
                "other",
                otherNetworks.map(toNetworkOption),
            );
        }

        const assetsByNormalizedId = new Map<string, SelectOption>();
        for (const asset of formattedAssets) {
            assetsByNormalizedId.set(
                canonicalizeTokenIdForMatch(asset.id),
                asset,
            );
            assetsByNormalizedId.set(asset.id.toLowerCase(), asset);

            const networks = newAssetNetworksMap.get(asset.id) || [];
            for (const network of networks) {
                assetsByNormalizedId.set(
                    canonicalizeTokenIdForMatch(network.id),
                    asset,
                );
                assetsByNormalizedId.set(network.id.toLowerCase(), asset);
                if (network.chainId) {
                    assetsByNormalizedId.set(
                        canonicalizeTokenIdForMatch(network.chainId),
                        asset,
                    );
                    assetsByNormalizedId.set(
                        network.chainId.toLowerCase(),
                        asset,
                    );
                }
            }
        }
        const popularOptions: SelectOption[] = [];
        const seenPopularIds = new Set<string>();
        for (const popularAsset of popularAssets) {
            if (!popularAsset.tokenId) continue;
            const normalizedPopularId = canonicalizeTokenIdForMatch(
                popularAsset.tokenId,
            );
            const matched =
                assetsByNormalizedId.get(normalizedPopularId) ||
                assetsByNormalizedId.get(popularAsset.tokenId.toLowerCase());
            if (matched && !seenPopularIds.has(matched.id)) {
                seenPopularIds.add(matched.id);
                popularOptions.push(matched);
            }
        }

        const sections: AssetSection[] = [];

        if (popularOptions.length > 0) {
            sections.push({
                title: t("sections.popularAssets"),
                options: popularOptions,
                display: "chips",
            });
        }

        sections.push({
            title: t("sections.yourAssets"),
            options: yourAssets,
        });
        sections.push({
            title: t("sections.otherAssets"),
            options: isConfidential
                ? otherAssets
                : [...otherAssets, otherAsset],
        });

        let nextFilteredNetworks: SelectOption[] = [];
        let nextSelectedNetworkBalances = new Map<
            string,
            NetworkBalanceDisplay
        >();

        let targetAsset: SelectOption | undefined;
        let networkFromTokenPrefill: SelectOption | null = null;
        if (prefillTokenId) {
            const targetId = normalizeNearAssetId(prefillTokenId).toLowerCase();
            targetAsset = formattedAssets.find(
                (asset) =>
                    normalizeNearAssetId(asset.id).toLowerCase() === targetId,
            );

            if (!targetAsset) {
                for (const asset of formattedAssets) {
                    const assetNetworks =
                        newAssetNetworksMap.get(asset.id) || [];
                    const matchedNetwork = assetNetworks.find((network) => {
                        const networkId = normalizeNearAssetId(
                            network.id,
                        ).toLowerCase();
                        const chainId = normalizeNearAssetId(
                            network.chainId,
                        ).toLowerCase();
                        return networkId === targetId || chainId === targetId;
                    });

                    if (matchedNetwork) {
                        targetAsset = asset;
                        networkFromTokenPrefill = matchedNetwork;
                        break;
                    }
                }
            }
        }

        if (!targetAsset && prefillNetworkId) {
            const normalizedPrefillNetworkId = prefillNetworkId.toLowerCase();
            for (const asset of formattedAssets) {
                const assetNetworks = newAssetNetworksMap.get(asset.id) || [];
                const matchedNetwork = assetNetworks.find(
                    (network) =>
                        network.id.toLowerCase() ===
                            normalizedPrefillNetworkId ||
                        (network.chainId || "").toLowerCase() ===
                            normalizedPrefillNetworkId ||
                        network.name
                            .toLowerCase()
                            .includes(normalizedPrefillNetworkId),
                );
                if (matchedNetwork) {
                    targetAsset = asset;
                    networkFromTokenPrefill = matchedNetwork;
                    break;
                }
            }
        }
        if (!targetAsset && !isAssetsPending) {
            targetAsset = pickDefaultDepositAsset(yourAssets, formattedAssets);
        }

        if (targetAsset) {
            const currentAsset = form.getValues("asset");
            if (currentAsset?.id !== targetAsset.id) {
                form.setValue("asset", targetAsset);
            }

            const availableNetworks =
                newAssetNetworksMap.get(targetAsset.id) || [];
            nextFilteredNetworks = availableNetworks.map((n) => ({
                ...n,
                name: getNetworkDisplayName(n.name),
            }));
            nextSelectedNetworkBalances =
                networkBalancesByAssetId.get(targetAsset.id) || new Map();

            let networkToSelect: SelectOption | null = networkFromTokenPrefill;

            if (prefillNetworkId) {
                const normalizedPrefillNetworkId =
                    prefillNetworkId.toLowerCase();
                const prefillNetwork = availableNetworks.find(
                    (n) =>
                        n.id.toLowerCase() === normalizedPrefillNetworkId ||
                        (n.chainId || "").toLowerCase() ===
                            normalizedPrefillNetworkId ||
                        n.name
                            .toLowerCase()
                            .includes(normalizedPrefillNetworkId),
                );
                if (prefillNetwork) networkToSelect = prefillNetwork;
            }

            const currentNetwork = form.getValues("network");
            if (networkToSelect) {
                if (currentNetwork?.id !== networkToSelect.id) {
                    form.setValue("network", networkToSelect);
                }
            } else if (currentAsset?.id !== targetAsset.id) {
                if (currentNetwork) form.setValue("network", null);
            }
        }

        dispatchDepositAssets({
            type: "LOAD_DEPOSIT_ASSETS",
            payload: {
                allAssets: formattedAssets,
                assetSections: sections,
                assetBalanceMap: assetBalancesById,
                assetNetworksMap: newAssetNetworksMap,
                networkBalancesByAsset: networkBalancesByAssetId,
                filteredNetworks: nextFilteredNetworks,
                selectedNetworkBalances: nextSelectedNetworkBalances,
            },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        bridgeAssets,
        aggregatedTreasuryTokens,
        isAssetsPending,
        prefillTokenId,
        prefillNetworkId,
        popularAssets,
        accountId,
        isConfidential,
    ]);

    const handleAssetSelect = useCallback(
        (asset: SelectOption) => {
            invalidatePendingAddressRequest();
            form.setValue("asset", asset);
            form.clearErrors();

            setDepositInfo(null);
            setSingleUseExpiresAt(null);
            setHasAcknowledged(false);
            lastPublicAutoFetchKeyRef.current = null;
            failedPublicFetchKeyRef.current = null;
            setStep("select");

            const availableNetworks = assetNetworksMap.get(asset.id) || [];
            dispatchDepositAssets({
                type: "SELECT_ASSET",
                payload: {
                    filteredNetworks: availableNetworks.map((n) => ({
                        ...n,
                        name: getNetworkDisplayName(n.name),
                    })),
                    selectedNetworkBalances:
                        networkBalancesByAsset.get(asset.id) || new Map(),
                },
            });

            if (availableNetworks.length === 1) {
                form.setValue("network", availableNetworks[0]);
            } else {
                form.setValue("network", null);
            }
        },
        [
            form,
            assetNetworksMap,
            networkBalancesByAsset,
            invalidatePendingAddressRequest,
        ],
    );

    const handleNetworkSelect = useCallback(
        (network: SelectOption) => {
            invalidatePendingAddressRequest();
            form.setValue("network", network);
            form.clearErrors();

            setDepositInfo(null);
            setSingleUseExpiresAt(null);
            setHasAcknowledged(false);
            lastPublicAutoFetchKeyRef.current = null;
            failedPublicFetchKeyRef.current = null;
            setStep("select");
        },
        [form, invalidatePendingAddressRequest],
    );

    const resolveAddress =
        useCallback(async (): Promise<DepositInfo | null> => {
            if (!selectedNetwork || !selectedAsset || !treasuryId) {
                return null;
            }

            const requestId = ++latestAddressRequestRef.current;

            if (selectedNetwork.id === NEAR_COM_DIRECT_NETWORK_ID) {
                if (requestId !== latestAddressRequestRef.current) return null;
                return {
                    address: treasuryId,
                    memo: null,
                    minDepositAmount: null,
                    expiresAtMs: null,
                };
            }

            if (!isConfidential) {
                const nearNetwork = (
                    selectedNetwork.chainId ?? selectedNetwork.id
                )
                    .toLowerCase()
                    .includes(NEAR_NETWORK_ID);
                if (nearNetwork) {
                    if (requestId !== latestAddressRequestRef.current)
                        return null;
                    return {
                        address: treasuryId,
                        memo: null,
                        minDepositAmount: null,
                        expiresAtMs: null,
                    };
                }
            }

            // Guests / non-members can generate deposit addresses (public + confidential).
            setIsLoadingAddress(true);
            form.clearErrors("network");

            try {
                const result = await fetchDepositAddress(
                    treasuryId,
                    selectedNetwork.chainId ?? selectedNetwork.id,
                    selectedNetwork.id,
                    selectedBridgeNetwork?.minDepositAmount,
                );

                if (requestId !== latestAddressRequestRef.current) return null;

                if (result?.address) {
                    form.clearErrors("network");
                    const parsedExpiresAt = result.expiresAt
                        ? Date.parse(result.expiresAt)
                        : Number.NaN;
                    return {
                        address: result.address,
                        memo: result.memo || null,
                        minDepositAmount: result.minAmount ?? null,
                        expiresAtMs: Number.isFinite(parsedExpiresAt)
                            ? parsedExpiresAt
                            : null,
                    };
                }

                form.setError("network", {
                    type: "manual",
                    message: t("errors.addressUnavailable"),
                });
                return null;
            } catch (err: unknown) {
                if (requestId !== latestAddressRequestRef.current) return null;
                form.setError("network", {
                    type: "manual",
                    message:
                        err instanceof Error
                            ? err.message
                            : t("errors.fetchFailed"),
                });
                return null;
            } finally {
                if (requestId === latestAddressRequestRef.current) {
                    setIsLoadingAddress(false);
                }
            }
        }, [
            selectedNetwork,
            selectedAsset,
            treasuryId,
            isConfidential,
            selectedBridgeNetwork,
            form,
            t,
        ]);

    // After login (or any account change), allow retrying a previously failed fetch.
    useEffect(() => {
        failedPublicFetchKeyRef.current = null;
    }, [accountId]);

    // Public treasuries: asset+network → address step (skeleton), then fetch.
    useEffect(() => {
        if (isConfidential) return;

        if (depositBlocked) {
            if (step === "address") {
                setDepositInfo(null);
                setSingleUseExpiresAt(null);
                setStep("select");
            }
            return;
        }

        if (!selectedAsset || !selectedNetwork) {
            setDepositInfo(null);
            setSingleUseExpiresAt(null);
            lastPublicAutoFetchKeyRef.current = null;
            return;
        }

        const fetchKey = `${selectedAsset.id}:${selectedNetwork.id}`;

        // Advance to a dedicated address page; keep select form off-screen.
        if (step === "select") {
            // Same pair already failed — keep form errors visible until user
            // re-selects or signs in (accountId effect clears the failure latch).
            if (failedPublicFetchKeyRef.current === fetchKey) return;
            setDepositInfo(null);
            setSingleUseExpiresAt(null);
            setStep("address");
            return;
        }

        if (step !== "address") return;
        if (lastPublicAutoFetchKeyRef.current === fetchKey && depositInfo)
            return;

        let cancelled = false;
        (async () => {
            const info = await resolveAddress();
            if (cancelled) return;
            if (!info) {
                failedPublicFetchKeyRef.current = fetchKey;
                setStep("select");
                return;
            }
            failedPublicFetchKeyRef.current = null;
            lastPublicAutoFetchKeyRef.current = fetchKey;
            setDepositInfo(info);
            setSingleUseExpiresAt(null);
        })();

        return () => {
            cancelled = true;
        };
    }, [
        isConfidential,
        step,
        selectedAsset?.id,
        selectedNetwork?.id,
        depositBlocked,
        depositInfo,
        resolveAddress,
    ]);

    const minDepositDisplay = useMemo(() => {
        const raw =
            depositInfo?.minDepositAmount ??
            selectedBridgeNetwork?.minDepositAmount;
        if (!raw) return null;
        return formatBalance(raw, selectedBridgeNetwork?.decimals ?? 0);
    }, [
        depositInfo?.minDepositAmount,
        selectedBridgeNetwork?.minDepositAmount,
        selectedBridgeNetwork?.decimals,
    ]);

    const networkDisplayName = selectedNetwork
        ? getNetworkDisplayName(selectedNetwork.name)
        : "";
    const assetSymbol =
        selectedBridgeNetwork?.symbol ?? selectedNetwork?.symbol ?? "";

    const handleSourceChange = (source: DepositSource) => {
        if (source === depositSource) return;
        setDepositSource(source);
        setHasAcknowledged(false);
        setStep("select");
        setDepositInfo(null);
        setSingleUseExpiresAt(null);
        invalidatePendingAddressRequest();
    };

    const handleGenerateOneTimeAddress = async () => {
        if (!hasAcknowledged || depositBlocked || isLoadingAddress) return;
        setDepositInfo(null);
        setSingleUseExpiresAt(null);
        setStep("address");
        const info = await resolveAddress();
        if (!info) {
            setStep("select");
            return;
        }
        setDepositInfo(info);
        setSingleUseExpiresAt(
            info.expiresAtMs ?? Date.now() + SINGLE_USE_VALIDITY_MS,
        );
    };

    const handleCreateNewAddress = async () => {
        if (isLoadingAddress || depositBlocked) return;
        setDepositInfo(null);
        setSingleUseExpiresAt(null);
        const info = await resolveAddress();
        if (!info) {
            setStep("select");
            return;
        }
        setDepositInfo(info);
        setSingleUseExpiresAt(
            info.expiresAtMs ?? Date.now() + SINGLE_USE_VALIDITY_MS,
        );
    };

    const handleShowConfidentialAddress = () => {
        if (!hasAcknowledged || !treasuryId) return;
        setDepositInfo({
            address: treasuryId,
            memo: null,
            minDepositAmount: null,
            expiresAtMs: null,
        });
        setSingleUseExpiresAt(null);
        setStep("address");
    };

    const handleShare = () => {
        if (!treasuryId || !depositInfo?.address) return;

        const isConfidentialShare =
            isConfidential && depositSource === "confidential_user";

        // Public share URL only after token, network, and deposit address are ready.
        const path = isConfidentialShare
            ? buildDepositTransferPath(treasuryId, {
                  type: "confidential",
                  source: confidentialOrigin,
              })
            : selectedAsset?.id && selectedNetwork?.id
              ? buildDepositTransferPath(treasuryId, {
                    type: "public",
                    address: depositInfo.address,
                    token: selectedAsset.id,
                    network: selectedNetwork.id,
                })
              : null;

        if (!path) return;
        router.push(path);
    };

    const handleBack = () => {
        if (step === "address") {
            if (!isConfidential) {
                // Clear network so re-selecting auto-opens the address step again.
                invalidatePendingAddressRequest();
                form.setValue("network", null);
                form.clearErrors("network");
                setDepositInfo(null);
                setSingleUseExpiresAt(null);
                lastPublicAutoFetchKeyRef.current = null;
                failedPublicFetchKeyRef.current = null;
            } else if (depositSource === "public_wallet") {
                // Clear generated one-time address so user must generate again.
                setDepositInfo(null);
                setSingleUseExpiresAt(null);
            }
            setStep("select");
            return;
        }
        router.push(`/${treasuryId!}/dashboard`);
    };

    const showAssetNetworkForm =
        !isConfidential || depositSource === "public_wallet";

    const showOneTimeAck =
        isConfidential &&
        depositSource === "public_wallet" &&
        !!selectedAsset &&
        !!selectedNetwork &&
        !depositBlocked &&
        step === "select";

    const showConfidentialAck =
        isConfidential &&
        depositSource === "confidential_user" &&
        step === "select";

    const addressNotices = useMemo(() => {
        if (!isConfidential) {
            return buildPublicTreasuryNotices(
                t,
                networkDisplayName,
                minDepositDisplay,
                assetSymbol,
            );
        }

        if (depositSource === "confidential_user") {
            return buildConfidentialOriginNotices(t, confidentialOrigin);
        }

        return buildPublicWalletOneTimeNotices(
            t,
            assetSymbol,
            networkDisplayName,
        );
    }, [
        isConfidential,
        depositSource,
        confidentialOrigin,
        minDepositDisplay,
        assetSymbol,
        networkDisplayName,
        t,
    ]);

    const addressTitle = useMemo(() => {
        if (!isConfidential) {
            return t("publicAddressTitle", {
                symbol: assetSymbol,
                network: networkDisplayName,
            });
        }
        if (depositSource === "confidential_user") {
            return confidentialOrigin === "trezu"
                ? t("confidentialTrezuTitle")
                : t("confidentialNearcomTitle");
        }
        return t("oneTimeAddressTitle", {
            symbol: assetSymbol,
            network: networkDisplayName,
        });
    }, [
        isConfidential,
        depositSource,
        confidentialOrigin,
        assetSymbol,
        networkDisplayName,
        t,
    ]);

    const addressSubtitle = useMemo(() => {
        if (!isConfidential) return t("publicAddressSubtitle");
        if (depositSource === "confidential_user") {
            return confidentialOrigin === "trezu"
                ? t("confidentialTrezuSubtitle")
                : t("confidentialNearcomSubtitle");
        }
        return t("oneTimeAddressSubtitle");
    }, [isConfidential, depositSource, confidentialOrigin, t]);

    return (
        <PageCard className="gap-2 w-full">
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={handleBack}
                        className="h-8 w-8"
                        data-testid="deposit-back-button"
                    >
                        <ArrowLeft className="size-4" />
                    </Button>
                    {step === "address" ? (
                        <p className="font-semibold text-sm">{t("back")}</p>
                    ) : (
                        <p className="font-semibold">{t("title")}</p>
                    )}
                </div>

                {step === "select" && showGuestBanner && <DepositGuestBanner />}

                {step === "select" && isConfidential && (
                    <DepositSourceCards
                        value={depositSource}
                        onChange={handleSourceChange}
                        disablePublicWallet={isConfidentialNearFallbackOnly}
                    />
                )}

                {step === "select" && showAssetNetworkForm && (
                    <>
                        <div className="border-t border-general-border pt-3">
                            <p className="text-sm font-semibold">
                                {t("subtitle")}
                            </p>
                        </div>
                        <SlotWarning slot="deposit" className="mb-0" />
                        <Form {...form}>
                            <div className="rounded-xl bg-muted overflow-hidden divide-y divide-general-border">
                                <FormField
                                    control={form.control}
                                    name="asset"
                                    render={({ fieldState }) => (
                                        <FormItem>
                                            <InputBlock
                                                title={t("assetLabel")}
                                                invalid={!!fieldState.error}
                                                className="rounded-none border-0 bg-transparent"
                                            >
                                                <Button
                                                    type="button"
                                                    onClick={() =>
                                                        setModalType("asset")
                                                    }
                                                    variant="unstyled"
                                                    disabled={
                                                        depositSelectorsDisabled ||
                                                        (isAssetsPending &&
                                                            !selectedAsset)
                                                    }
                                                    data-testid="deposit-asset-selector"
                                                    className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                                >
                                                    <div className="w-full flex items-center justify-between py-1">
                                                        {isAssetsPending &&
                                                        !selectedAsset ? (
                                                            <div className="flex items-center gap-2">
                                                                <Skeleton className="size-6 rounded-full shrink-0" />
                                                                <Skeleton className="h-5 w-24" />
                                                            </div>
                                                        ) : selectedAsset ? (
                                                            <div className="flex items-center gap-2">
                                                                <DepositOptionIcon
                                                                    icon={
                                                                        selectedAsset.icon
                                                                    }
                                                                    name={
                                                                        selectedAsset.name
                                                                    }
                                                                    gradient={
                                                                        selectedAsset.gradient
                                                                    }
                                                                />
                                                                <span className="text-foreground font-medium capitalize">
                                                                    {
                                                                        selectedAsset.name
                                                                    }
                                                                </span>
                                                            </div>
                                                        ) : (
                                                            <span className="text-muted-foreground text-lg font-normal">
                                                                {t(
                                                                    "selectAsset",
                                                                )}
                                                            </span>
                                                        )}
                                                        <ChevronDown className="w-5 h-5" />
                                                    </div>
                                                </Button>
                                                <FormMessage />
                                            </InputBlock>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name="network"
                                    render={({ fieldState }) => (
                                        <FormItem>
                                            <InputBlock
                                                title={t("networkLabel")}
                                                invalid={!!fieldState.error}
                                                className="rounded-none border-0 bg-transparent"
                                            >
                                                <Button
                                                    type="button"
                                                    onClick={() =>
                                                        setModalType("network")
                                                    }
                                                    variant="unstyled"
                                                    disabled={
                                                        depositSelectorsDisabled
                                                    }
                                                    data-testid="deposit-network-selector"
                                                    className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                                >
                                                    <div className="w-full flex flex-col gap-0 py-1">
                                                        {selectedNetwork ? (
                                                            <>
                                                                <div className="flex items-center justify-between">
                                                                    <div className="flex items-center gap-2">
                                                                        <DepositOptionIcon
                                                                            icon={
                                                                                selectedNetwork.icon
                                                                            }
                                                                            name={
                                                                                selectedNetwork.name
                                                                            }
                                                                            gradient={
                                                                                selectedNetwork.gradient ||
                                                                                "bg-linear-to-br from-green-500 to-teal-500"
                                                                            }
                                                                        />
                                                                        <div className="flex flex-col">
                                                                            <span
                                                                                className={cn(
                                                                                    "text-foreground font-medium",
                                                                                    getNetworkDisplayCaseClass(
                                                                                        selectedNetwork.name,
                                                                                        "uppercase",
                                                                                    ),
                                                                                )}
                                                                            >
                                                                                {getNetworkDisplayName(
                                                                                    selectedNetwork.name,
                                                                                )}
                                                                            </span>
                                                                            {selectedNetwork.description && (
                                                                                <span className="text-xs text-muted-foreground font-normal">
                                                                                    {
                                                                                        selectedNetwork.description
                                                                                    }
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    <ChevronDown className="w-5 h-5" />
                                                                </div>
                                                                {selectedAsset?.id ===
                                                                    "other" && (
                                                                    <div className="break-all overflow-wrap-anywhere text-wrap mt-2 text-xs text-general-info-foreground">
                                                                        {t(
                                                                            "otherNetworkInfo",
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </>
                                                        ) : (
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-muted-foreground text-lg font-normal">
                                                                    {t(
                                                                        "selectNetwork",
                                                                    )}
                                                                </span>
                                                                <ChevronDown className="w-5 h-5" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </Button>
                                                {fieldState.error ? (
                                                    <FormMessage />
                                                ) : null}
                                            </InputBlock>
                                        </FormItem>
                                    )}
                                />
                            </div>
                        </Form>
                    </>
                )}

                {depositBlocked &&
                    selectedAsset &&
                    selectedNetwork &&
                    step === "select" &&
                    showAssetNetworkForm && (
                        <div className="space-y-3">
                            <SlotWarning
                                slot={depositScopeWarning?.slot ?? "deposit"}
                                token={depositScopeWarning?.token ?? undefined}
                                network={
                                    depositScopeWarning?.network ?? undefined
                                }
                                action="deposit"
                            />
                        </div>
                    )}

                {depositScopedMessage && step === "select" && (
                    <WarningMessage
                        variant="inline"
                        message={depositScopedMessage}
                        className="text-sm"
                    />
                )}

                {showOneTimeAck && (
                    <DepositAckPanel
                        title={t("oneTimeSectionTitle")}
                        subtitle={t("oneTimeSectionSubtitle")}
                        items={[
                            ...(minDepositDisplay
                                ? [
                                      {
                                          id: "min",
                                          tone: "success" as const,
                                          content: t.rich("minDepositValue", {
                                              amount: minDepositDisplay,
                                              symbol: assetSymbol,
                                              bold: (chunks) => (
                                                  <span className="text-foreground">
                                                      {chunks}
                                                  </span>
                                              ),
                                          }),
                                      },
                                  ]
                                : []),
                            {
                                id: "no-test",
                                tone: "danger",
                                content: t.rich("doNotSendTestDeposit", {
                                    bold: (chunks) => (
                                        <span className="text-foreground">
                                            {chunks}
                                        </span>
                                    ),
                                }),
                            },
                            {
                                id: "no-reuse",
                                tone: "danger",
                                content: t.rich("doNotReuseAddress", {
                                    bold: (chunks) => (
                                        <span className="text-foreground">
                                            {chunks}
                                        </span>
                                    ),
                                }),
                            },
                        ]}
                        checkboxLabel={
                            minDepositDisplay
                                ? t("oneTimeAckCheckbox", {
                                      amount: minDepositDisplay,
                                      symbol: assetSymbol,
                                  })
                                : t("oneTimeAckCheckboxNoMin")
                        }
                        checked={hasAcknowledged}
                        onCheckedChange={setHasAcknowledged}
                        ctaLabel={t("generateAddress")}
                        onCta={handleGenerateOneTimeAddress}
                        ctaLoading={isLoadingAddress}
                    />
                )}

                {showConfidentialAck && (
                    <DepositAckPanel
                        title={t("internalAddressTitle")}
                        items={[
                            {
                                id: "receives-only",
                                tone: "success",
                                content: (
                                    <span className="font-semibold text-foreground">
                                        {t("receivesOnlyConfidential")}
                                    </span>
                                ),
                                subtext: t("receivesOnlyConfidentialSub"),
                            },
                            {
                                id: "anything-else",
                                tone: "danger",
                                content: (
                                    <span className="font-semibold text-foreground">
                                        {t("anythingElseLost")}
                                    </span>
                                ),
                                subtext: t("anythingElseLostSub"),
                            },
                        ]}
                        checkboxLabel={t("confidentialAckCheckbox")}
                        checked={hasAcknowledged}
                        onCheckedChange={setHasAcknowledged}
                        ctaLabel={t("showAddress")}
                        onCta={handleShowConfidentialAddress}
                    />
                )}

                {step === "address" && (isLoadingAddress || !depositInfo) && (
                    <DepositAddressSkeleton />
                )}

                {step === "address" && depositInfo && !isLoadingAddress && (
                    <DepositAddressView
                        title={addressTitle}
                        subtitle={addressSubtitle}
                        address={depositInfo.address}
                        memo={depositInfo.memo}
                        preferPlainAddress={
                            isConfidential &&
                            depositSource === "confidential_user"
                        }
                        notices={addressNotices}
                        onShare={handleShare}
                        onCreateNewAddress={
                            isConfidential && depositSource === "public_wallet"
                                ? handleCreateNewAddress
                                : undefined
                        }
                        createNewAddressDisabled={isLoadingAddress}
                        headerSlot={
                            isConfidential &&
                            depositSource === "confidential_user" ? (
                                <DepositConfidentialSourceTabs
                                    value={confidentialOrigin}
                                    onChange={setConfidentialOrigin}
                                />
                            ) : undefined
                        }
                    />
                )}
            </div>

            <SelectModal
                isOpen={modalType === "asset"}
                onClose={() => setModalType(null)}
                onSelect={(option) => {
                    handleAssetSelect(option);
                    setModalType(null);
                }}
                title={t("selectAsset")}
                options={allAssets}
                sections={assetSections}
                searchPlaceholder={t("searchByName")}
                isLoading={isLoadingAssets}
                selectedId={selectedAsset?.id}
                renderRight={(item) => {
                    const balanceData = assetBalanceMap.get(item.id);
                    if (!balanceData) return null;
                    return renderBalance(
                        balanceData.balance,
                        balanceData.balanceUSD,
                    );
                }}
            />

            <SelectModal
                isOpen={modalType === "network"}
                onClose={() => setModalType(null)}
                onSelect={(option) => {
                    handleNetworkSelect(option);
                    setModalType(null);
                }}
                title={t("selectNetwork")}
                options={filteredNetworks}
                sections={networkSections}
                searchPlaceholder={t("searchByName")}
                isLoading={isLoadingAssets}
                selectedId={selectedNetwork?.id}
                renderContent={(item) => {
                    const option = item as SelectOption;
                    return (
                        <div className="flex-1 text-left">
                            <div
                                className={cn(
                                    "font-semibold",
                                    getNetworkDisplayCaseClass(
                                        option.name,
                                        "uppercase",
                                    ),
                                )}
                            >
                                {option.name || option.symbol}
                            </div>
                            {option.description && (
                                <div className="text-xs text-muted-foreground font-normal">
                                    {option.description}
                                </div>
                            )}
                            {option.symbol && (
                                <div className="text-sm text-muted-foreground">
                                    {option.symbol}
                                </div>
                            )}
                        </div>
                    );
                }}
                renderRight={(item) => {
                    const networkBalance = selectedNetworkBalances.get(item.id);
                    if (!networkBalance) return null;
                    return renderBalance(
                        networkBalance.amount,
                        networkBalance.amountUSD,
                    );
                }}
            />
        </PageCard>
    );
}

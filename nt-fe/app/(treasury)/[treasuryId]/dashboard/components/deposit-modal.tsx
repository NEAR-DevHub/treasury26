import { zodResolver } from "@hookform/resolvers/zod";
import {
    ArrowLeft,
    ChevronDown,
    CircleCheck,
    Globe,
    Shield,
    TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { trackEvent } from "@/lib/analytics";
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { useForm } from "react-hook-form";
import QRCode from "react-qr-code";
import { z } from "zod";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { InputBlock } from "@/components/input-block";
import { getNetworkDisplayName } from "@/components/token-display";
import {
    NEAR_NETWORK_ID,
    NEAR_COM_DIRECT_NETWORK_ID,
    NEAR_COM_NETWORK_NAME,
} from "@/constants/network-ids";
import { NEAR_CHAIN_ICONS } from "@/constants/token";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { PageCard } from "@/components/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/underline-tabs";
import {
    type AggregatedAsset,
    useAggregatedTokens,
    useAssets,
} from "@/hooks/use-assets";
import { usePopularAssetsByActivity } from "@/hooks/use-treasury-queries";
import { type BridgeNetwork, useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import Big from "@/lib/big";
import { fetchDepositAddress } from "@/lib/bridge-api";
import { getNetworkDisplayCaseClass } from "@/lib/intents-network";
import { buildSectionedOptions } from "@/lib/section-rules";
import {
    canonicalizeTokenIdForMatch,
    cn,
    formatBalance,
    formatCurrencyWithSubCent,
    formatSmartAmount,
    normalizeNearAssetId,
} from "@/lib/utils";
import { SelectModal } from "./select-modal";

interface DepositPageContentProps {
    /** Optional token id to prefill (e.g., "usdc", "near") */
    prefillTokenId?: string;
    /** Optional network ID to prefill (e.g., "near:mainnet") */
    prefillNetworkId?: string;
}

interface SelectOption {
    id: string;
    name: string;
    description?: string;
    symbol?: string;
    icon: string;
    gradient?: string;
    networks?: BridgeNetwork[];
    chainId?: string;
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
const SINGLE_USE_VALIDITY_MS = 3 * 24 * 60 * 60 * 1000;

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
        icon: iconUrl || network.name.charAt(0),
        gradient: "bg-linear-to-br from-green-500 to-teal-500",
        chainId: network.chainId,
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

function OptionIcon({
    icon,
    name,
    gradient,
}: {
    icon: string;
    name: string;
    gradient?: string;
}) {
    const isUrl =
        icon?.startsWith("http") ||
        icon?.startsWith("data:") ||
        icon?.startsWith("/");

    if (isUrl) {
        return (
            <div className="w-6 h-6 rounded-full overflow-hidden shrink-0">
                <img
                    src={icon}
                    alt={name}
                    className="w-full h-full rounded-full object-contain"
                />
            </div>
        );
    }

    return (
        <div
            className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-normal shrink-0",
                gradient ?? "bg-brand-blue",
            )}
        >
            {icon}
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
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const {
        data: { tokens: treasuryAssets } = { tokens: STABLE_EMPTY_ARRAY },
    } = useAssets(treasuryId, {
        onlyPositiveBalance: false,
        onlySupportedTokens: true,
    });
    const aggregatedTreasuryTokens = useAggregatedTokens(treasuryAssets);
    // Prevent old async responses from updating state.
    const latestAddressRequestRef = useRef(0);
    const form = useForm<DepositFormValues>({
        resolver: zodResolver(depositFormSchema),
        mode: "onChange",
        defaultValues: {
            asset: null,
            network: null,
        },
    });

    const [modalType, setModalType] = useState<"asset" | "network" | null>(
        null,
    );
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
    const [depositInfo, setDepositInfo] = useState<{
        address: string;
        memo: string | null;
        minDepositAmount: string | null;
    } | null>(null);
    const [isLoadingAddress, setIsLoadingAddress] = useState(false);
    const [hasAcknowledgedSingleUse, setHasAcknowledgedSingleUse] =
        useState(false);
    const [singleUseExpiresAt, setSingleUseExpiresAt] = useState<number | null>(
        null,
    );
    const [countdownNow, setCountdownNow] = useState(Date.now());
    const [addressSourceTab, setAddressSourceTab] = useState<
        "public" | "confidential"
    >("public");
    const { data: popularAssets = [] } = usePopularAssetsByActivity();

    const selectedAsset = form.watch("asset");
    const selectedNetwork = form.watch("network");
    const { data: bridgeAssets = [], isLoading: isLoadingAssets } =
        useBridgeTokens(true);

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

    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());
        const nextToken = selectedAsset?.id || null;
        const nextNetwork = selectedNetwork?.id || null;
        const currentToken = params.get("token");
        const currentNetwork = params.get("network");

        if (nextToken === currentToken && nextNetwork === currentNetwork) {
            return;
        }

        if (nextToken) {
            params.set("token", nextToken);
        } else {
            params.delete("token");
        }

        if (nextNetwork) {
            params.set("network", nextNetwork);
        } else {
            params.delete("network");
        }

        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, {
            scroll: false,
        });
    }, [
        selectedAsset?.id,
        selectedNetwork?.id,
        pathname,
        router,
        searchParams,
    ]);

    // Get the selected network's bridge data to access min amounts
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

    const networkSections = useMemo(() => {
        if (isConfidential && isGuestTreasury) {
            return buildSectionedOptions(filteredNetworks, [
                {
                    title: t("sections.available"),
                    filter: (network) =>
                        network.id === NEAR_COM_DIRECT_NETWORK_ID,
                },
                {
                    title: t("sections.forMembersOnly"),
                    filter: () => true,
                    disabled: true,
                },
            ]);
        }

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
    }, [
        filteredNetworks,
        selectedNetworkBalances,
        isConfidential,
        isGuestTreasury,
        t,
    ]);

    useEffect(() => {
        if (!bridgeAssets.length) return;

        form.clearErrors();

        // Add "Other" asset that deposits directly to treasury
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

        // Build per-asset network lists (each asset gets its own dedicated list)
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

        // Add "Other" at the end (not for confidential — it only supports NEAR network)
        if (!isConfidential) {
            formattedAssets.push(otherAsset);
            newAssetNetworksMap.set(
                "other",
                otherAsset.networks!.map(toNetworkOption),
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

        // Auto-select asset:
        // 1) explicit prefill token, 2) owned USDC, 3) first token in "Your Assets",
        // 4) any USDC option, 5) first available
        let targetAsset: SelectOption | undefined;
        let networkFromTokenPrefill: SelectOption | null = null;
        if (prefillTokenId) {
            const targetId = normalizeNearAssetId(prefillTokenId).toLowerCase();
            targetAsset = formattedAssets.find(
                (asset) =>
                    normalizeNearAssetId(asset.id).toLowerCase() === targetId,
            );

            // Non-NEAR proposals often pass network-level token IDs (contract IDs).
            // If asset ID doesn't match directly, resolve asset by matching one of its networks.
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

        // If token is not provided (or didn't resolve), derive asset from network prefill.
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
        if (!targetAsset) {
            targetAsset =
                yourAssets.find(
                    (asset) => asset.id?.toLowerCase() === "usdc",
                ) ||
                yourAssets[0] ||
                formattedAssets.find(
                    (asset) => asset.id?.toLowerCase() === "usdc",
                ) ||
                formattedAssets[0];
        }

        if (targetAsset) {
            form.setValue("asset", targetAsset);

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

            if (!networkToSelect && availableNetworks.length === 1) {
                networkToSelect = availableNetworks[0];
            }

            if (networkToSelect) {
                form.setValue("network", networkToSelect);
            } else {
                form.setValue("network", null);
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
        prefillTokenId,
        prefillNetworkId,
        popularAssets,
    ]);

    // Handle asset selection - show all assets but update network list
    const handleAssetSelect = useCallback(
        (asset: SelectOption) => {
            form.setValue("asset", asset);
            form.clearErrors();

            setDepositInfo(null);

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

            // Auto-select network only when there is exactly one option.
            if (availableNetworks.length === 1) {
                form.setValue("network", availableNetworks[0]);
            } else if (
                selectedNetwork &&
                !availableNetworks.some((n) => n.id === selectedNetwork.id)
            ) {
                form.setValue("network", null);
            }
        },
        [form, assetNetworksMap, selectedNetwork, networkBalancesByAsset],
    );

    // Handle network selection
    const handleNetworkSelect = useCallback(
        (network: SelectOption) => {
            form.setValue("network", network);
            form.clearErrors();

            setDepositInfo(null);
        },
        [form],
    );

    // Fetch deposit address when both asset and network are selected
    useEffect(() => {
        const fetchAddress = async () => {
            if (!selectedNetwork || !selectedAsset) {
                setDepositInfo(null);
                setSingleUseExpiresAt(null);
                return;
            }
            const requestId = ++latestAddressRequestRef.current;

            if (selectedNetwork.id === NEAR_COM_DIRECT_NETWORK_ID) {
                if (requestId !== latestAddressRequestRef.current) return;
                setDepositInfo({
                    address: treasuryId!,
                    memo: null,
                    minDepositAmount: null,
                });
                setSingleUseExpiresAt(null);
                return;
            }

            // All NEAR networks deposit directly to treasury account ID
            // (except confidential treasuries which always go through intents)
            if (!isConfidential) {
                const isNearNetwork = (
                    selectedNetwork.chainId ?? selectedNetwork.id
                )
                    .toLowerCase()
                    .includes(NEAR_NETWORK_ID);
                if (isNearNetwork) {
                    if (requestId !== latestAddressRequestRef.current) return;
                    setDepositInfo({
                        address: treasuryId!,
                        memo: null,
                        minDepositAmount: null,
                    });
                    setSingleUseExpiresAt(null);
                    return;
                }
            }

            setIsLoadingAddress(true);
            form.clearErrors("network");

            try {
                const result = await fetchDepositAddress(
                    treasuryId!,
                    selectedNetwork.chainId ?? selectedNetwork.id,
                    selectedNetwork.id,
                    selectedBridgeNetwork?.minDepositAmount,
                );

                if (result && result.address) {
                    if (requestId !== latestAddressRequestRef.current) return;
                    setDepositInfo({
                        address: result.address,
                        memo: result.memo || null,
                        minDepositAmount: result.minAmount ?? null,
                    });
                    setSingleUseExpiresAt(
                        isConfidential
                            ? Date.now() + SINGLE_USE_VALIDITY_MS
                            : null,
                    );
                    form.clearErrors("network");
                } else {
                    if (requestId !== latestAddressRequestRef.current) return;
                    setDepositInfo(null);
                    setSingleUseExpiresAt(null);
                    form.setError("network", {
                        type: "manual",
                        message: t("errors.addressUnavailable"),
                    });
                }
            } catch (err: any) {
                if (requestId !== latestAddressRequestRef.current) return;
                form.setError("network", {
                    type: "manual",
                    message: err.message || t("errors.fetchFailed"),
                });
                setDepositInfo(null);
                setSingleUseExpiresAt(null);
            } finally {
                if (requestId !== latestAddressRequestRef.current) return;
                setIsLoadingAddress(false);
            }
        };

        if (selectedAsset && selectedNetwork) {
            fetchAddress();
        } else {
            setDepositInfo(null);
            setSingleUseExpiresAt(null);
        }
    }, [
        selectedAsset,
        selectedNetwork,
        isConfidential,
        selectedBridgeNetwork,
        t,
        treasuryId,
    ]);

    const isNearNetworkSelected = isNearNetworkId(
        selectedNetwork?.chainId ?? selectedNetwork?.id,
    );

    const formatAddress = useCallback(
        (address: string) => {
            if (isNearNetworkSelected) {
                return <span>{address}</span>;
            }

            if (address.length <= 12) {
                return <span className="font-bold">{address}</span>;
            }

            const first6 = address.slice(0, 6);
            const middle = address.slice(6, -6);
            const last6 = address.slice(-6);

            return (
                <>
                    <span className="font-bold">{first6}</span>
                    <span>{middle}</span>
                    <span className="font-bold">{last6}</span>
                </>
            );
        },
        [isNearNetworkSelected],
    );

    const canSwitchDepositSource = isConfidential && isNearNetworkSelected;
    const isConfidentialSourceSelected =
        canSwitchDepositSource && addressSourceTab === "confidential";
    const showConfidentialDepositWarning =
        isConfidential && !isConfidentialSourceSelected;
    const displayDepositInfo = isConfidentialSourceSelected
        ? {
              address: treasuryId!,
              memo: null,
              minDepositAmount: null,
          }
        : depositInfo;
    const showAddressLoading =
        isLoadingAddress && !isConfidentialSourceSelected;
    const onlyDepositNetworkName = isConfidentialSourceSelected
        ? NEAR_COM_NETWORK_NAME
        : selectedNetwork
          ? getNetworkDisplayName(selectedNetwork.name)
          : "";
    const networkDisplayCaseClass = isConfidentialSourceSelected
        ? "lowercase"
        : selectedNetwork
          ? getNetworkDisplayCaseClass(selectedNetwork.name)
          : "capitalize";
    const shouldBlurConfidentialAddress =
        showConfidentialDepositWarning && !hasAcknowledgedSingleUse;
    const singleUseExpiresIn = useMemo(() => {
        if (!singleUseExpiresAt) return "0m";
        const remainingMs = Math.max(0, singleUseExpiresAt - countdownNow);
        const totalMinutes = Math.floor(remainingMs / 60000);
        const days = Math.floor(totalMinutes / (60 * 24));
        const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
        const minutes = totalMinutes % 60;

        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }, [singleUseExpiresAt, countdownNow]);

    useEffect(() => {
        if (!canSwitchDepositSource && addressSourceTab !== "public") {
            setAddressSourceTab("public");
        }
    }, [canSwitchDepositSource, addressSourceTab]);

    useEffect(() => {
        setHasAcknowledgedSingleUse(false);
    }, [showConfidentialDepositWarning, displayDepositInfo?.address]);

    useEffect(() => {
        if (!showConfidentialDepositWarning || !singleUseExpiresAt) return;
        setCountdownNow(Date.now());
        const timer = setInterval(() => {
            setCountdownNow(Date.now());
        }, 60000);
        return () => clearInterval(timer);
    }, [showConfidentialDepositWarning, singleUseExpiresAt]);

    const formContent = useMemo(
        () => (
            <Form {...form}>
                <div>
                    {/* Asset Select */}
                    <FormField
                        control={form.control}
                        name="asset"
                        render={({ fieldState }) => (
                            <FormItem>
                                <InputBlock
                                    title={t("assetLabel")}
                                    invalid={!!fieldState.error}
                                    className="rounded-b-none border-b border-general-border border-l-0! border-r-0! border-t-0!"
                                >
                                    <Button
                                        type="button"
                                        onClick={() => setModalType("asset")}
                                        variant="unstyled"
                                        data-testid="deposit-asset-selector"
                                        className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                    >
                                        <div className="w-full flex items-center justify-between py-1">
                                            {selectedAsset ? (
                                                <div className="flex items-center gap-2">
                                                    <OptionIcon
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
                                                        {selectedAsset.name}
                                                    </span>
                                                </div>
                                            ) : (
                                                <span className="text-muted-foreground text-lg font-normal">
                                                    {t("selectAsset")}
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

                    {/* Network Select */}
                    <FormField
                        control={form.control}
                        name="network"
                        render={({ fieldState }) => (
                            <FormItem>
                                <InputBlock
                                    title={t("networkLabel")}
                                    invalid={!!fieldState.error}
                                    className="rounded-t-none border-l-0! border-r-0! border-t-0! border-b-0!"
                                >
                                    <Button
                                        type="button"
                                        onClick={() => setModalType("network")}
                                        variant="unstyled"
                                        data-testid="deposit-network-selector"
                                        className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                    >
                                        <div className="w-full flex flex-col gap-0 py-1">
                                            {selectedNetwork ? (
                                                <>
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-2">
                                                            <OptionIcon
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
                                                    {/* Info message for "Other" asset */}
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
                                                        {t("selectNetwork")}
                                                    </span>
                                                    <ChevronDown className="w-5 h-5" />
                                                </div>
                                            )}
                                        </div>
                                    </Button>
                                    <FormMessage />
                                </InputBlock>
                            </FormItem>
                        )}
                    />

                    {/* Deposit Address Section */}
                    {showAddressLoading && (
                        <div className="mt-6 space-y-4 animate-pulse">
                            <div>
                                <div className="h-6 bg-muted rounded w-48 mb-2" />
                                <div className="h-4 bg-muted rounded w-72" />
                            </div>

                            <div className="bg-muted rounded-lg p-2">
                                <div className="flex gap-4">
                                    {/* QR Code Skeleton */}
                                    <div className="shrink-0">
                                        <div className="size-[88px] bg-background rounded-lg" />
                                    </div>

                                    {/* Address Skeleton */}
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 bg-background rounded w-20" />
                                        <div className="bg-background rounded-lg p-3"></div>
                                    </div>
                                </div>
                            </div>

                            {/* Warning Skeleton */}
                            <div className="bg-muted rounded-lg p-3 flex gap-3">
                                <div className="w-5 h-5 bg-background rounded shrink-0" />
                                <div className="flex-1 space-y-2">
                                    <div className="h-4 bg-background rounded w-full" />
                                    <div className="h-4 bg-background rounded w-3/4" />
                                </div>
                            </div>
                        </div>
                    )}

                    {displayDepositInfo && !showAddressLoading && (
                        <div className="mt-6 space-y-3">
                            <div>
                                <h3 className="font-semibold mb-1">
                                    {t("depositAddressHeading")}
                                </h3>
                                <p className="text-sm text-muted-foreground">
                                    {t("depositAddressSubtitle")}
                                </p>
                            </div>

                            {canSwitchDepositSource && (
                                <Tabs
                                    value={addressSourceTab}
                                    onValueChange={(value) =>
                                        setAddressSourceTab(
                                            value as "public" | "confidential",
                                        )
                                    }
                                    className="gap-0"
                                >
                                    <TabsList className="px-2 pb-0 border-b border-border">
                                        <TabsTrigger
                                            value="public"
                                            className="text-base font-semibold pb-2"
                                        >
                                            <Globe className="size-5" />
                                            <span>{t("tabs.fromPublic")}</span>
                                        </TabsTrigger>
                                        <TabsTrigger
                                            value="confidential"
                                            className="text-base font-semibold pb-2"
                                        >
                                            <Shield className="size-5 fill-current" />
                                            <span>
                                                {t("tabs.fromConfidential")}
                                            </span>
                                        </TabsTrigger>
                                    </TabsList>
                                </Tabs>
                            )}
                            <div className="relative bg-muted rounded-lg space-y-2 p-1.5">
                                {showConfidentialDepositWarning && (
                                    <div className="rounded-md p-2">
                                        <p className="text-sm text-general-info-foreground">
                                            {t.rich(
                                                "depositAddressSubtitleConfidential",
                                                {
                                                    semibold: (chunks) => (
                                                        <span className="font-semibold">
                                                            {chunks}
                                                        </span>
                                                    ),
                                                },
                                            )}
                                        </p>
                                        <p className="mt-2 text-sm text-general-info-foreground">
                                            {t(
                                                "depositAddressSubtitleConfidentialExpiry",
                                                {
                                                    expiresIn:
                                                        singleUseExpiresIn,
                                                },
                                            )}
                                        </p>
                                    </div>
                                )}

                                <div
                                    className={cn(
                                        "relative flex items-start gap-3 rounded-lg",
                                        showConfidentialDepositWarning &&
                                            "bg-card p-2",
                                    )}
                                >
                                    <div
                                        className={cn(
                                            "flex items-start gap-3 w-full",
                                            shouldBlurConfidentialAddress &&
                                                "select-none blur-sm",
                                        )}
                                    >
                                        {/* QR Code */}
                                        <div className="shrink-0">
                                            <div className="size-[88px] rounded-lg flex items-center justify-center">
                                                <QRCode
                                                    value={
                                                        displayDepositInfo.address
                                                    }
                                                    size={88}
                                                />
                                            </div>
                                        </div>

                                        {/* Address */}
                                        <div className="flex-1 space-y-2 pt-1">
                                            <label className="text-sm text-muted-foreground">
                                                {t("addressLabel")}
                                            </label>
                                            <div className="rounded-lg flex justify-between gap-2">
                                                <code className="font-mono break-all text-xs sm:text-sm">
                                                    {formatAddress(
                                                        displayDepositInfo.address,
                                                    )}
                                                </code>
                                                <CopyButton
                                                    text={
                                                        displayDepositInfo.address
                                                    }
                                                    toastMessage={t(
                                                        "addressCopied",
                                                    )}
                                                    variant="unstyled"
                                                    size="icon-sm"
                                                    className="shrink-0"
                                                    iconClassName="w-5 h-5 text-muted-foreground"
                                                    disabled={
                                                        shouldBlurConfidentialAddress
                                                    }
                                                />
                                            </div>

                                            {/* Memo field */}
                                            {displayDepositInfo.memo && (
                                                <>
                                                    <label className="text-sm text-muted-foreground">
                                                        {t("memoLabel")}
                                                    </label>
                                                    <div className="rounded-lg flex justify-between gap-2">
                                                        <code className="font-mono break-all text-xs sm:text-sm">
                                                            {
                                                                displayDepositInfo.memo
                                                            }
                                                        </code>
                                                        <CopyButton
                                                            text={
                                                                displayDepositInfo.memo
                                                            }
                                                            toastMessage={t(
                                                                "memoCopied",
                                                            )}
                                                            variant="unstyled"
                                                            size="icon-sm"
                                                            className="shrink-0"
                                                            iconClassName="w-5 h-5 text-muted-foreground"
                                                        />
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    {shouldBlurConfidentialAddress && (
                                        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                onClick={() =>
                                                    setHasAcknowledgedSingleUse(
                                                        true,
                                                    )
                                                }
                                                className="pointer-events-auto h-10 rounded-xl bg-background px-5 text-sm font-medium shadow-md"
                                            >
                                                {t("singleUseAcknowledgement")}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-2 mt-4">
                                <div className="flex gap-2 items-start text-sm text-muted-foreground">
                                    <CircleCheck className="h-4 w-4 shrink-0 mt-0.5" />
                                    <span>
                                        {t.rich("onlyDeposit", {
                                            symbol:
                                                selectedNetwork?.symbol ?? "",
                                            network: onlyDepositNetworkName,
                                            symbolTag: (chunks) => (
                                                <span className="text-foreground">
                                                    {chunks}
                                                </span>
                                            ),
                                            networkTag: (chunks) => (
                                                <span
                                                    className={cn(
                                                        "text-foreground",
                                                        networkDisplayCaseClass,
                                                    )}
                                                >
                                                    {chunks}
                                                </span>
                                            ),
                                        })}
                                        {!showConfidentialDepositWarning && (
                                            <>
                                                {" "}
                                                {t(
                                                    "testTransactionRecommendation",
                                                )}
                                            </>
                                        )}
                                    </span>
                                </div>

                                {(displayDepositInfo?.minDepositAmount ||
                                    selectedBridgeNetwork?.minDepositAmount) && (
                                    <div className="flex gap-2 items-start text-sm text-muted-foreground">
                                        <CircleCheck className="h-4 w-4 shrink-0 mt-0.5" />
                                        <span>
                                            {t.rich("minimumDeposit", {
                                                amount: formatBalance(
                                                    displayDepositInfo?.minDepositAmount ??
                                                        selectedBridgeNetwork!
                                                            .minDepositAmount!,
                                                    selectedBridgeNetwork?.decimals ??
                                                        0,
                                                ),
                                                symbol:
                                                    selectedNetwork?.symbol ??
                                                    "",
                                                amountTag: (chunks) => (
                                                    <span className="text-foreground">
                                                        {chunks}
                                                    </span>
                                                ),
                                            })}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Memo warning */}
                            {displayDepositInfo.memo && (
                                <div className="flex gap-2 items-start text-sm bg-destructive/10 text-destructive rounded-lg p-3">
                                    <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
                                    <span>
                                        {t.rich("memoWarning", {
                                            bold: (chunks) => (
                                                <span className="font-semibold">
                                                    {chunks}
                                                </span>
                                            ),
                                        })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

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
                            const networkBalance = selectedNetworkBalances.get(
                                item.id,
                            );
                            if (!networkBalance) return null;
                            return renderBalance(
                                networkBalance.amount,
                                networkBalance.amountUSD,
                            );
                        }}
                    />
                </div>
            </Form>
        ),
        [
            form,
            t,
            selectedAsset,
            selectedNetwork,
            showAddressLoading,
            displayDepositInfo,
            canSwitchDepositSource,
            addressSourceTab,
            showConfidentialDepositWarning,
            shouldBlurConfidentialAddress,
            singleUseExpiresIn,
            formatAddress,
            onlyDepositNetworkName,
            networkDisplayCaseClass,
            selectedBridgeNetwork,
            modalType,
            allAssets,
            assetSections,
            isLoadingAssets,
            assetBalanceMap,
            handleAssetSelect,
            filteredNetworks,
            networkSections,
            handleNetworkSelect,
            selectedNetworkBalances,
        ],
    );

    return (
        <PageCard className="gap-2 w-full">
            <div className="flex flex-col">
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => router.push(`/${treasuryId!}/dashboard`)}
                        className="h-8 w-8"
                    >
                        <ArrowLeft className="size-4" />
                    </Button>
                    <p className="font-semibold">{t("title")}</p>
                </div>
                <p className="text-sm mt-2 font-semibold">{t("subtitle")}</p>
            </div>
            <div>{formContent}</div>
        </PageCard>
    );
}

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, CircleCheck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { trackEvent } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import QRCode from "react-qr-code";
import { z } from "zod";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { InputBlock } from "@/components/input-block";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { getNetworkDisplayName } from "@/components/token-display";
import {
    NEAR_NETWORK_ID,
    NEAR_COM_DIRECT_NETWORK_ID,
    NEAR_COM_NETWORK_NAME,
} from "@/constants/network-ids";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useAggregatedTokens, useAssets } from "@/hooks/use-assets";
import { NEAR_COM_ICON } from "@/constants/token";
import { type BridgeNetwork, useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import Big from "@/lib/big";
import { fetchDepositAddress } from "@/lib/bridge-api";
import { getNetworkDisplayCaseClass } from "@/lib/intents-network";
import { buildSectionedOptions } from "@/lib/section-rules";
import {
    cn,
    formatBalance,
    formatSmartAmount,
    normalizeNearAssetId,
} from "@/lib/utils";
import { useThemeStore } from "@/stores/theme-store";
import { SelectModal } from "./select-modal";

interface DepositModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Optional token symbol to prefill (e.g., "USDC", "NEAR") */
    prefillTokenSymbol?: string;
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

export function DepositModal({
    isOpen,
    onClose,
    prefillTokenSymbol,
    prefillNetworkId,
}: DepositModalProps) {
    const t = useTranslations("depositModal");
    const tRecipientNetwork = useTranslations("recipientNetworkSelect");
    const depositFormSchema = useMemo(
        () =>
            buildDepositFormSchema({
                selectAsset: t("validation.selectAsset"),
                selectNetwork: t("validation.selectNetwork"),
            }),
        [t],
    );
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const { theme } = useThemeStore();
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
    const [allAssets, setAllAssets] = useState<SelectOption[]>([]);
    const [assetSections, setAssetSections] = useState<
        { title: string; options: SelectOption[] }[]
    >([]);
    const [assetBalanceMap, setAssetBalanceMap] = useState<
        Map<string, { balance: string; balanceUSD: number }>
    >(new Map());
    // Per-asset network lists: asset.id → SelectOption[] (each list is specific to that asset)
    const [assetNetworksMap, setAssetNetworksMap] = useState<
        Map<string, SelectOption[]>
    >(new Map());
    const [networkBalancesByAsset, setNetworkBalancesByAsset] = useState<
        Map<string, Map<string, NetworkBalanceDisplay>>
    >(new Map());
    const [selectedNetworkBalances, setSelectedNetworkBalances] = useState<
        Map<string, NetworkBalanceDisplay>
    >(new Map());
    const [filteredNetworks, setFilteredNetworks] = useState<SelectOption[]>(
        [],
    );
    const [depositInfo, setDepositInfo] = useState<{
        address: string;
        memo: string | null;
        minDepositAmount: string | null;
    } | null>(null);
    const [isLoadingAddress, setIsLoadingAddress] = useState(false);
    const [hasAcknowledgedSingleUse, setHasAcknowledgedSingleUse] =
        useState(false);

    const selectedAsset = form.watch("asset");
    const selectedNetwork = form.watch("network");

    const { data: bridgeAssets = [], isLoading: isLoadingAssets } =
        useBridgeTokens(isOpen);

    useEffect(() => {
        if (selectedAsset && selectedNetwork) {
            trackEvent("deposit-asset-and-network-selected", {
                treasury_id: treasuryId ?? "",
                asset_id: selectedAsset.id,
                asset_name: selectedAsset.name,
                network_id: selectedNetwork.id,
                network_name: selectedNetwork.name,
            });
        }
    }, [selectedAsset?.id, selectedNetwork?.id]);

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

        const withAssets = filteredNetworks
            .filter((network) => {
                const balance = selectedNetworkBalances.get(network.id);
                return !!balance && Big(balance.amount).gt(0);
            })
            .sort((a, b) => {
                const aUSD = selectedNetworkBalances.get(a.id)?.amountUSD || 0;
                const bUSD = selectedNetworkBalances.get(b.id)?.amountUSD || 0;
                if (aUSD !== bUSD) return bUSD - aUSD;
                return a.name.localeCompare(b.name);
            });

        const supportedNetworks = filteredNetworks
            .filter((network) => {
                const balance = selectedNetworkBalances.get(network.id);
                return !balance || !Big(balance.amount).gt(0);
            })
            .sort((a, b) => {
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
        if (!isOpen || !bridgeAssets.length) return;

        form.clearErrors("asset");
        form.clearErrors("network");

        // Add "Other" asset that deposits directly to treasury
        const otherAsset: SelectOption = {
            id: "other",
            name: t("otherAssetName"),
            icon: "O",
            gradient: "bg-gradient-cyan-blue",
            networks: [
                {
                    id: "other:near",
                    name: "Near",
                    symbol: "Other",
                    chainIcons: null,
                    chainId: "near:mainnet",
                    decimals: 24,
                },
            ],
        };

        // Helper: convert a BridgeNetwork to a SelectOption with theme-aware icon
        const toNetworkOption = (network: BridgeNetwork): SelectOption => {
            const iconUrl = network.chainIcons
                ? theme === "dark"
                    ? network.chainIcons.dark
                    : network.chainIcons.light
                : null;
            return {
                id: network.id,
                name: network.name,
                icon: iconUrl || network.name.charAt(0),
                gradient: "bg-linear-to-br from-green-500 to-teal-500",
                chainId: network.chainId,
            };
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

        const buildNetworkBalanceMap = (
            assetId: string,
            bridgeNetworks: BridgeNetwork[],
        ): Map<string, NetworkBalanceDisplay> => {
            const balances = new Map<string, NetworkBalanceDisplay>();
            const ownedAsset = ownedTreasuryAssetsById.get(
                assetId.toLowerCase(),
            );

            if (!ownedAsset) return balances;

            // Match each bridge network to treasury-held balances in priority order:
            // 1) exact contract-id match (after normalizing `nep141:` prefix),
            // 2) for NEAR token on NEAR network, aggregate all NEAR residencies,
            // 3) fallback for native chain entries without contractId by chain name.
            // Then sum matched balances into a single display amount per bridge network.
            for (const bridgeNetwork of bridgeNetworks) {
                const normalizedBridgeId = normalizeNearAssetId(
                    bridgeNetwork.id,
                );
                const byContractId = ownedAsset.networks.filter(
                    (network) =>
                        normalizeNearAssetId(network.contractId) ===
                        normalizedBridgeId,
                );

                const bridgeNetworkName = bridgeNetwork.name.toLowerCase();
                const includeAllNearResidencies =
                    assetId.toLowerCase() === NEAR_NETWORK_ID &&
                    bridgeNetworkName === NEAR_NETWORK_ID;

                const chainMatches = ownedAsset.networks.filter(
                    (network) =>
                        network.network.toLowerCase() === bridgeNetworkName,
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
        };

        const nearDirectNetworkOption = (): SelectOption => ({
            id: NEAR_COM_DIRECT_NETWORK_ID,
            name: NEAR_COM_NETWORK_NAME,
            description: isConfidential
                ? tRecipientNetwork("nearComDescription")
                : undefined,
            icon: NEAR_COM_ICON,
        });

        for (const asset of bridgeAssets) {
            const networks = asset.networks.map(toNetworkOption);
            if (isConfidential) {
                networks.unshift(nearDirectNetworkOption());
            }
            newAssetNetworksMap.set(asset.id, networks);
            networkBalancesByAssetId.set(
                asset.id,
                buildNetworkBalanceMap(asset.id, asset.networks),
            );

            const normalizedId = asset.id.toLowerCase();
            const ownedAsset = ownedTreasuryAssetsById.get(normalizedId);
            const selectOption: SelectOption = {
                id: asset.id,
                name: asset.name,
                symbol: asset.networks[0]?.symbol,
                icon: asset.icon,
                gradient: "bg-gradient-cyan-blue",
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

        console.log(
            `[DepositModal] main useEffect: setting state (allAssets: ${formattedAssets.length}, networks map size: ${newAssetNetworksMap.size})`,
        );
        setAllAssets(formattedAssets);
        setAssetNetworksMap(newAssetNetworksMap);
        setNetworkBalancesByAsset(networkBalancesByAssetId);
        setAssetBalanceMap(assetBalancesById);
        setAssetSections([
            {
                title: t("sections.yourAssets"),
                options: yourAssets,
            },
            {
                title: t("sections.otherAssets"),
                options: isConfidential
                    ? otherAssets
                    : [...otherAssets, otherAsset],
            },
        ]);

        // Auto-select asset:
        // 1) explicit prefill token, 2) owned USDC, 3) first token in "Your Assets",
        // 4) any USDC option, 5) first available
        let targetAsset: SelectOption | undefined;
        if (prefillTokenSymbol) {
            const targetId = prefillTokenSymbol.toLowerCase();
            targetAsset = formattedAssets.find(
                (asset) => asset.id?.toLowerCase() === targetId,
            );
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
            setFilteredNetworks(
                availableNetworks.map((n) => ({
                    ...n,
                    name: getNetworkDisplayName(n.name),
                })),
            );
            setSelectedNetworkBalances(
                networkBalancesByAssetId.get(targetAsset.id) || new Map(),
            );

            let networkToSelect: SelectOption | null = null;

            if (prefillNetworkId) {
                const prefillNetwork = availableNetworks.find(
                    (n) =>
                        n.id === prefillNetworkId ||
                        n.chainId === prefillNetworkId ||
                        n.name
                            .toLowerCase()
                            .includes(prefillNetworkId.toLowerCase()),
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        isOpen,
        bridgeAssets,
        aggregatedTreasuryTokens,
        prefillTokenSymbol,
        prefillNetworkId,
        theme,
    ]);

    // Handle asset selection - show all assets but update network list
    const handleAssetSelect = useCallback(
        (asset: SelectOption) => {
            form.setValue("asset", asset);
            form.clearErrors("asset");
            form.clearErrors("network");

            setDepositInfo(null);

            const availableNetworks = assetNetworksMap.get(asset.id) || [];
            setFilteredNetworks(
                availableNetworks.map((n) => ({
                    ...n,
                    name: getNetworkDisplayName(n.name),
                })),
            );
            setSelectedNetworkBalances(
                networkBalancesByAsset.get(asset.id) || new Map(),
            );

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
            form.clearErrors("network");
            form.clearErrors("asset");

            setDepositInfo(null);
        },
        [form],
    );

    // Fetch deposit address when both asset and network are selected
    useEffect(() => {
        const fetchAddress = async () => {
            if (!treasuryId || !selectedNetwork || !selectedAsset) {
                setDepositInfo(null);
                return;
            }
            const requestId = ++latestAddressRequestRef.current;

            if (selectedNetwork.id === NEAR_COM_DIRECT_NETWORK_ID) {
                if (requestId !== latestAddressRequestRef.current) return;
                setDepositInfo({
                    address: treasuryId,
                    memo: null,
                    minDepositAmount: null,
                });
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
                        address: treasuryId,
                        memo: null,
                        minDepositAmount: null,
                    });
                    return;
                }
            }

            setIsLoadingAddress(true);
            form.clearErrors("network");

            try {
                const result = await fetchDepositAddress(
                    treasuryId,
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
                    form.clearErrors("network");
                } else {
                    if (requestId !== latestAddressRequestRef.current) return;
                    setDepositInfo(null);
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
            } finally {
                if (requestId !== latestAddressRequestRef.current) return;
                setIsLoadingAddress(false);
            }
        };

        if (selectedAsset && selectedNetwork && treasuryId) {
            fetchAddress();
        } else {
            setDepositInfo(null);
        }
    }, [
        selectedAsset,
        selectedNetwork,
        treasuryId,
        isConfidential,
        selectedBridgeNetwork,
        t,
    ]);

    // Reset all state when modal closes
    const handleClose = useCallback(() => {
        latestAddressRequestRef.current += 1;
        form.reset();
        setDepositInfo(null);
        setFilteredNetworks([]);
        setSelectedNetworkBalances(new Map());
        setModalType(null);
        onClose();
    }, [form, onClose]);

    // Helper function to format address with bold first and last 6 characters
    const formatAddress = (address: string) => {
        // Check if it's a NEAR network (treasury address) - don't apply bold formatting
        const isNearNetwork = (
            selectedNetwork?.chainId ??
            selectedNetwork?.id ??
            ""
        )
            .toLowerCase()
            .includes(NEAR_NETWORK_ID);

        if (isNearNetwork) {
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
    };

    const renderBalance = (amount: number | string, amountUSD: number) => {
        const normalizedAmount = amount.toString();
        if (!Big(normalizedAmount).gt(0)) {
            return null;
        }
        const normalizedUsd = Number.isFinite(amountUSD)
            ? amountUSD.toFixed(2)
            : "0.00";

        return (
            <div className="flex flex-col items-end">
                <span className="font-semibold">
                    {formatSmartAmount(normalizedAmount)}
                </span>
                <span className="text-sm text-muted-foreground">
                    ≈${normalizedUsd}
                </span>
            </div>
        );
    };

    const isNearComSelected =
        selectedNetwork?.id === NEAR_COM_DIRECT_NETWORK_ID;
    const showConfidentialDepositWarning = isConfidential && !isNearComSelected;
    const onlyDepositNetworkName = selectedNetwork
        ? getNetworkDisplayName(selectedNetwork.name)
        : "";
    const networkDisplayCaseClass = selectedNetwork
        ? getNetworkDisplayCaseClass(selectedNetwork.name)
        : "capitalize";
    const shouldBlurConfidentialAddress =
        showConfidentialDepositWarning && !hasAcknowledgedSingleUse;

    useEffect(() => {
        setHasAcknowledgedSingleUse(false);
    }, [showConfidentialDepositWarning, depositInfo?.address]);

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t("title")}</DialogTitle>
                </DialogHeader>

                <Form {...form}>
                    <div>
                        <p className="font-semibold pb-2">{t("subtitle")}</p>

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
                                            onClick={() =>
                                                setModalType("asset")
                                            }
                                            variant="unstyled"
                                            className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                        >
                                            <div className="w-full flex items-center justify-between py-1">
                                                {selectedAsset ? (
                                                    <div className="flex items-center gap-2">
                                                        {selectedAsset.icon?.startsWith(
                                                            "http",
                                                        ) ||
                                                        selectedAsset.icon?.startsWith(
                                                            "data:",
                                                        ) ||
                                                        selectedAsset.icon?.startsWith(
                                                            "/",
                                                        ) ? (
                                                            <img
                                                                src={
                                                                    selectedAsset.icon
                                                                }
                                                                alt={
                                                                    selectedAsset.name
                                                                }
                                                                className="w-6 h-6 rounded-full object-contain"
                                                            />
                                                        ) : (
                                                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold bg-gradient-cyan-blue">
                                                                <span>
                                                                    {
                                                                        selectedAsset.icon
                                                                    }
                                                                </span>
                                                            </div>
                                                        )}
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
                                            onClick={() =>
                                                setModalType("network")
                                            }
                                            variant="unstyled"
                                            className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                        >
                                            <div className="w-full flex flex-col gap-0 py-1">
                                                {selectedNetwork ? (
                                                    <>
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex items-center gap-2">
                                                                {selectedNetwork.icon?.startsWith(
                                                                    "http",
                                                                ) ||
                                                                selectedNetwork.icon?.startsWith(
                                                                    "data:",
                                                                ) ||
                                                                selectedNetwork.icon?.startsWith(
                                                                    "/",
                                                                ) ? (
                                                                    <div className="w-6 h-6 rounded-full object-cover">
                                                                        <img
                                                                            src={
                                                                                selectedNetwork.icon
                                                                            }
                                                                            alt={
                                                                                selectedNetwork.name
                                                                            }
                                                                            className="w-full h-full"
                                                                        />
                                                                    </div>
                                                                ) : (
                                                                    <div
                                                                        className={`w-6 h-6 rounded-full ${
                                                                            selectedNetwork.gradient ||
                                                                            "bg-linear-to-br from-green-500 to-teal-500"
                                                                        } flex items-center justify-center text-white text-xs font-bold`}
                                                                    >
                                                                        <span>
                                                                            {
                                                                                selectedNetwork.icon
                                                                            }
                                                                        </span>
                                                                    </div>
                                                                )}
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
                        {isLoadingAddress && (
                            <div className="mt-6 space-y-4 animate-pulse">
                                <div>
                                    <div className="h-6 bg-muted rounded w-48 mb-2" />
                                    <div className="h-4 bg-muted rounded w-72" />
                                </div>

                                <div className="bg-muted rounded-lg p-2">
                                    <div className="flex gap-4">
                                        {/* QR Code Skeleton */}
                                        <div className="shrink-0">
                                            <div className="w-32 h-32 bg-background rounded-lg" />
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

                        {depositInfo && !isLoadingAddress && (
                            <div className="mt-6 space-y-3">
                                <div>
                                    <h3 className="font-semibold mb-1">
                                        {t("depositAddressHeading")}
                                    </h3>
                                    <p className="text-sm text-muted-foreground">
                                        {t("depositAddressSubtitle")}
                                    </p>
                                </div>

                                <div className="bg-muted rounded-lg space-y-2 p-1.5">
                                    {showConfidentialDepositWarning && (
                                        <div className="rounded-md bg-general-warning/10 p-2">
                                            <p className="text-sm text-general-warning-foreground">
                                                {t(
                                                    "depositAddressSubtitleConfidential",
                                                )}
                                            </p>
                                            <label className="mt-2 flex items-center gap-2 text-sm text-general-unofficial-ghost-foreground">
                                                <Checkbox
                                                    checked={
                                                        hasAcknowledgedSingleUse
                                                    }
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
                                                        setHasAcknowledgedSingleUse(
                                                            checked === true,
                                                        )
                                                    }
                                                    className="mt-0.5"
                                                />
                                                <span>
                                                    {t(
                                                        "singleUseAcknowledgement",
                                                    )}
                                                </span>
                                            </label>
                                        </div>
                                    )}

                                    <div
                                        className={cn(
                                            "flex items-start gap-3 rounded-lg",
                                            showConfidentialDepositWarning &&
                                                "bg-card p-1",
                                            shouldBlurConfidentialAddress &&
                                                "select-none blur-sm",
                                        )}
                                    >
                                        {/* QR Code */}
                                        <div className="shrink-0">
                                            <div className="w-24 h-24 sm:w-40 sm:h-40 rounded-lg flex items-center justify-center p-2">
                                                <QRCode
                                                    value={depositInfo.address}
                                                    size={112}
                                                    style={{
                                                        height: "auto",
                                                        maxWidth: "100%",
                                                        width: "100%",
                                                    }}
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
                                                        depositInfo.address,
                                                    )}
                                                </code>
                                                <CopyButton
                                                    text={depositInfo.address}
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
                                            {depositInfo.memo && (
                                                <>
                                                    <label className="text-sm text-muted-foreground">
                                                        {t("memoLabel")}
                                                    </label>
                                                    <div className="rounded-lg flex justify-between gap-2">
                                                        <code className="font-mono break-all text-xs sm:text-sm">
                                                            {depositInfo.memo}
                                                        </code>
                                                        <CopyButton
                                                            text={
                                                                depositInfo.memo
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
                                </div>

                                <div className="space-y-2 mt-4">
                                    <div className="flex gap-2 items-start text-sm text-muted-foreground">
                                        <CircleCheck className="h-4 w-4 shrink-0 mt-0.5" />
                                        <span>
                                            {t.rich("onlyDeposit", {
                                                symbol:
                                                    selectedNetwork?.symbol ??
                                                    "",
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

                                    {(depositInfo?.minDepositAmount ||
                                        selectedBridgeNetwork?.minDepositAmount) && (
                                        <div className="flex gap-2 items-start text-sm text-muted-foreground">
                                            <CircleCheck className="h-4 w-4 shrink-0 mt-0.5" />
                                            <span>
                                                {t.rich("minimumDeposit", {
                                                    amount: formatBalance(
                                                        depositInfo?.minDepositAmount ??
                                                            selectedBridgeNetwork!
                                                                .minDepositAmount!,
                                                        selectedBridgeNetwork?.decimals ??
                                                            0,
                                                    ),
                                                    symbol:
                                                        selectedNetwork?.symbol ??
                                                        "",
                                                    amountTag: (chunks) => (
                                                        <span className="text-foreground font-semibold">
                                                            {chunks}
                                                        </span>
                                                    ),
                                                })}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {/* Memo warning */}
                                {depositInfo.memo && (
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
                                const balanceData = assetBalanceMap.get(
                                    item.id,
                                );
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
                            fixNear
                            roundIcons={false}
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
                                const networkBalance =
                                    selectedNetworkBalances.get(item.id);
                                if (!networkBalance) return null;
                                return renderBalance(
                                    networkBalance.amount,
                                    networkBalance.amountUSD,
                                );
                            }}
                        />
                    </div>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

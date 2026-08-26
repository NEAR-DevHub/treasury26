"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
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
import { HighlightedText } from "@/components/highlighted-text";
import { getNetworkDisplayName } from "@/components/token-display";
import {
    parseWarningCopy,
    SlotWarning,
    WarningMessage,
} from "@/components/warning-message";
import {
    NEAR_COM_DIRECT_NETWORK_ID,
    NEAR_NETWORK_ID,
} from "@/constants/network-ids";
import {
    DEFAULT_ASSETS_QUERY,
    useAggregatedTokens,
    useAssets,
} from "@/hooks/use-assets";
import { useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useDepositAddressStatus } from "@/hooks/use-deposit-address-status";
import { useDepositExpiryClock } from "@/hooks/use-deposit-expiry-clock";
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
import { withNearComAddressPrefix } from "@/lib/nearcom-address";
import { cn, formatCurrencyWithSubCent, formatSmartAmount } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { DepositAckPanel } from "./deposit/deposit-ack-panel";
import {
    DepositAddressSkeleton,
    DepositAddressView,
} from "./deposit/deposit-address-view";
import {
    type AssetSection,
    buildDepositAssetCatalog,
    type NetworkBalanceDisplay,
    resolvePrefillSelection,
} from "./deposit/deposit-asset-catalog";
import { DepositAssetNetworkForm } from "./deposit/deposit-asset-network-form";
import {
    DEPOSIT_ADDRESS_VALIDITY_MS,
    isDepositAddressExpired,
} from "./deposit/deposit-expires";
import {
    buildConfidentialOriginNotices,
    buildPublicTreasuryNotices,
    buildPublicWalletOneTimeNotices,
} from "./deposit/deposit-notices";
import { DepositSourceCards } from "./deposit/deposit-source-cards";
import {
    buildPaySharePath,
    getAbsoluteTransferUrl,
} from "./deposit/deposit-transfer-url";
import type {
    DepositInfo,
    DepositSource,
    DepositStep,
    SelectOption,
} from "./deposit/deposit-types";
import { formatMinDepositDisplay } from "./deposit/format-min-deposit";
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

const STABLE_EMPTY_ARRAY: never[] = [];

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
    const { treasuryId, isConfidential, config } = useTreasury();
    const { accountId } = useNear();
    const locale = useLocale();
    const {
        data: { tokens: treasuryAssets } = { tokens: STABLE_EMPTY_ARRAY },
        isPending: isAssetsPending,
    } = useAssets(treasuryId, DEFAULT_ASSETS_QUERY);
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

    const [step, setStep] = useState<DepositStep>("select");
    const [depositSource, setDepositSource] =
        useState<DepositSource>("public_wallet");
    const [hasAcknowledged, setHasAcknowledged] = useState(false);
    const [modalType, setModalType] = useState<"asset" | "network" | null>(
        null,
    );
    /** Successfully resolved public asset+network key (skip refetch on address). */
    const lastPublicAutoFetchKeyRef = useRef<string | null>(null);
    /** Failed public asset+network key (block auto-advance until selection/login changes). */
    const failedPublicFetchKeyRef = useRef<string | null>(null);
    /** User left address for this pair — don't auto-advance until selection changes. */
    const dismissedAddressKeyRef = useRef<string | null>(null);
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
    const previousTreasuryIdRef = useRef(treasuryId);
    // Stable empty defaults — inline `= []` creates a new reference every
    // render while the query is pending, which re-fires the load effect
    // (popularAssets is a dependency) and triggers React error.
    const { data: popularAssets = STABLE_EMPTY_ARRAY } =
        usePopularAssetsByActivity();

    const selectedAsset = form.watch("asset");
    const selectedNetwork = form.watch("network");
    // Confidential path has no asset/network pickers — no scoped warnings UI.
    const depositWarningToken =
        depositSource === "confidential_user" ? undefined : selectedAsset?.id;
    const depositWarningNetwork =
        depositSource === "confidential_user"
            ? undefined
            : selectedNetwork?.name;
    const {
        warning: depositScopeWarning,
        blocked: depositBlocked,
        scopedMessage: depositScopedMessage,
    } = useScopedSlotWarning(
        "deposit",
        depositWarningToken,
        depositWarningNetwork,
    );
    // Token/network-scoped pause: keep selectors enabled so the user can switch.
    // Slot-wide / app pause: disable selectors and confidential Show address.
    const depositTokenNetworkScoped =
        isTokenOrNetworkScopedWarning(depositScopeWarning);
    const isDepositSlotWideBlocked =
        depositBlocked && !depositTokenNetworkScoped;
    const isConfidentialUserSource = depositSource === "confidential_user";
    // Public wallet (or public treasury): scoped pause/slow placement.
    const showPublicSelectWarnings =
        step === "select" && !isConfidentialUserSource && depositBlocked;
    const showSelectTokenNetworkBannerBelow =
        showPublicSelectWarnings &&
        Boolean(depositScopeWarning?.token && depositScopeWarning?.network);
    const showSelectTokenPausedInline =
        showPublicSelectWarnings &&
        Boolean(depositScopeWarning?.token && !depositScopeWarning?.network);
    const showSelectNetworkPausedInline =
        showPublicSelectWarnings &&
        Boolean(depositScopeWarning?.network && !depositScopeWarning?.token);
    const showSelectSlotWideBanner =
        step === "select" && isDepositSlotWideBlocked;
    const showAddressWarningBanner =
        step === "address" &&
        !isConfidentialUserSource &&
        depositScopeWarning?.response === "notice" &&
        depositTokenNetworkScoped;
    // Flatten heading+body so inline field copy shows the full sentence.
    let inlineScopedMessage: string | null = null;
    if (
        depositScopedMessage &&
        (showSelectTokenPausedInline || showSelectNetworkPausedInline)
    ) {
        const { heading, body } = parseWarningCopy(depositScopedMessage);
        inlineScopedMessage =
            heading && body
                ? `${heading} ${body}`
                : heading || body || depositScopedMessage;
    }
    const {
        data: bridgeAssets = STABLE_EMPTY_ARRAY,
        isLoading: isLoadingAssets,
    } = useBridgeTokens(true);
    const depositSelectorsDisabled =
        isLoadingAssets || isDepositSlotWideBlocked;

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
        setHasAcknowledged(false);
        setModalType(null);
        setDepositInfo(null);
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

        const sections: { title: string; options: SelectOption[] }[] = [];
        if (withAssets.length > 0) {
            sections.push({
                title: t("sections.networksWithAssets"),
                options: withAssets,
            });
        }
        if (supportedNetworks.length > 0) {
            sections.push({
                title: t("sections.supportedNetworks"),
                options: supportedNetworks,
            });
        }
        return sections;
    }, [filteredNetworks, selectedNetworkBalances, t]);

    useEffect(() => {
        if (!bridgeAssets.length) return;

        form.clearErrors();

        const catalog = buildDepositAssetCatalog({
            bridgeAssets,
            aggregatedTreasuryTokens,
            popularAssets,
            isConfidential,
            otherAssetName: t("otherAssetName"),
            labels: {
                popularAssets: t("sections.popularAssets"),
                yourAssets: t("sections.yourAssets"),
                otherAssets: t("sections.otherAssets"),
            },
        });

        const {
            targetAsset,
            networkToSelect,
            filteredNetworks: nextFilteredNetworks,
            selectedNetworkBalances: nextSelectedNetworkBalances,
        } = resolvePrefillSelection({
            catalog,
            prefillTokenId,
            prefillNetworkId,
            isAssetsPending,
        });

        if (targetAsset) {
            const currentAsset = form.getValues("asset");
            // Only write when the selection actually changes — re-running this
            // effect (e.g. popular assets arriving) must not churn form state.
            if (currentAsset?.id !== targetAsset.id) {
                form.setValue("asset", targetAsset);
            }

            const currentNetwork = form.getValues("network");
            if (networkToSelect) {
                if (currentNetwork?.id !== networkToSelect.id) {
                    form.setValue("network", networkToSelect);
                }
            } else if (currentAsset?.id !== targetAsset.id) {
                // Default asset just changed — clear any prior network.
                if (currentNetwork) form.setValue("network", null);
            }
        }

        dispatchDepositAssets({
            type: "LOAD_DEPOSIT_ASSETS",
            payload: {
                ...catalog,
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
        isConfidential,
        t,
    ]);

    // Handle asset selection - show all assets but update network list
    const handleAssetSelect = useCallback(
        (asset: SelectOption) => {
            invalidatePendingAddressRequest();
            form.setValue("asset", asset);
            form.clearErrors();

            setDepositInfo(null);
            setHasAcknowledged(false);
            lastPublicAutoFetchKeyRef.current = null;
            failedPublicFetchKeyRef.current = null;
            setStep("select");

            const availableNetworks = assetNetworksMap.get(asset.id) || [];
            dispatchDepositAssets({
                type: "SELECT_ASSET",
                payload: {
                    filteredNetworks: availableNetworks,
                    selectedNetworkBalances:
                        networkBalancesByAsset.get(asset.id) || new Map(),
                },
            });

            // Always clear network — user must pick explicitly (even if only one).
            form.setValue("network", null);
        },
        [
            form,
            assetNetworksMap,
            networkBalancesByAsset,
            invalidatePendingAddressRequest,
        ],
    );

    // Handle network selection
    const handleNetworkSelect = useCallback(
        (network: SelectOption) => {
            invalidatePendingAddressRequest();
            form.setValue("network", network);
            form.clearErrors();

            setDepositInfo(null);
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
                    quoteDepositAddress: null,
                };
            }

            // All NEAR networks deposit directly to treasury account ID
            // (except confidential treasuries which always go through intents)
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
                        quoteDepositAddress: null,
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
                        quoteDepositAddress: result.quoteDepositAddress ?? null,
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
    // A critical (blocking) warning on this token/network pauses deposits, so we
    // skip fetching the address entirely and show the paused notice instead.
    useEffect(() => {
        if (isConfidential) return;

        if (depositBlocked) {
            if (step === "address") {
                setDepositInfo(null);
                setStep("select");
            }
            return;
        }

        if (!selectedAsset || !selectedNetwork) {
            setDepositInfo(null);
            lastPublicAutoFetchKeyRef.current = null;
            return;
        }

        const fetchKey = `${selectedAsset.id}:${selectedNetwork.id}`;

        if (
            dismissedAddressKeyRef.current &&
            dismissedAddressKeyRef.current !== fetchKey
        ) {
            dismissedAddressKeyRef.current = null;
        }

        // Advance to a dedicated address page; keep select form off-screen.
        if (step === "select") {
            // Same pair already failed — keep form errors visible until user
            // re-selects or signs in (accountId effect clears the failure latch).
            if (failedPublicFetchKeyRef.current === fetchKey) return;
            if (dismissedAddressKeyRef.current === fetchKey) return;
            setDepositInfo(null);
            setStep("address");
            return;
        }

        if (step !== "address") return;
        if (
            lastPublicAutoFetchKeyRef.current === fetchKey &&
            depositInfo?.address
        )
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
        depositInfo?.address,
        resolveAddress,
    ]);

    const minDepositDisplay = useMemo(
        () =>
            formatMinDepositDisplay(
                depositInfo?.minDepositAmount ??
                    selectedBridgeNetwork?.minDepositAmount,
                selectedBridgeNetwork?.decimals ?? 0,
            ),
        [
            depositInfo?.minDepositAmount,
            selectedBridgeNetwork?.minDepositAmount,
            selectedBridgeNetwork?.decimals,
        ],
    );

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
        invalidatePendingAddressRequest();
    };

    const mintOneTimeAddress = async (options?: {
        requireAck?: boolean;
        advanceToAddress?: boolean;
    }) => {
        const requireAck = options?.requireAck ?? false;
        const advanceToAddress = options?.advanceToAddress ?? false;
        if (requireAck && !hasAcknowledged) return;
        if (depositBlocked || isLoadingAddress) return;
        setDepositInfo(null);
        if (advanceToAddress) setStep("address");
        const info = await resolveAddress();
        if (!info) {
            setStep("select");
            return;
        }
        setDepositInfo({
            ...info,
            expiresAtMs:
                info.expiresAtMs ?? Date.now() + DEPOSIT_ADDRESS_VALIDITY_MS,
        });
    };

    const handleGenerateOneTimeAddress = () =>
        mintOneTimeAddress({ requireAck: true, advanceToAddress: true });

    const handleCreateNewAddress = () => mintOneTimeAddress();

    const handleBackFromAddress = useCallback(() => {
        // Remember this asset+network so the public auto-advance effect does
        // not immediately bounce the user back to the address step.
        if (selectedAsset?.id && selectedNetwork?.id) {
            dismissedAddressKeyRef.current = `${selectedAsset.id}:${selectedNetwork.id}`;
        }
        setDepositInfo(null);
        setStep("select");
        invalidatePendingAddressRequest();
    }, [
        invalidatePendingAddressRequest,
        selectedAsset?.id,
        selectedNetwork?.id,
    ]);

    const handleShowConfidentialAddress = () => {
        if (!hasAcknowledged || !treasuryId || isDepositSlotWideBlocked) {
            return;
        }
        setDepositInfo({
            // Trezu / near.com confidential deposits use a nearcom: recipient.
            address: withNearComAddressPrefix(treasuryId),
            memo: null,
            minDepositAmount: null,
            expiresAtMs: null,
            quoteDepositAddress: null,
        });
        setStep("address");
    };

    const handleShare = () => {
        if (!treasuryId || !depositInfo?.address) return;

        const isConfidentialShare =
            isConfidential && depositSource === "confidential_user";

        // Confidential one-time: quote id only (asset/expiry from status API).
        // Public treasury: bridge address + token/network for display.
        const path = isConfidentialShare
            ? buildPaySharePath(treasuryId, {
                  kind: "confidential",
                  source: "nearcom",
              })
            : isConfidential && depositInfo.quoteDepositAddress
              ? buildPaySharePath(treasuryId, {
                    kind: "public",
                    id: depositInfo.quoteDepositAddress,
                })
              : selectedAsset?.id && selectedNetwork?.id
                ? buildPaySharePath(treasuryId, {
                      kind: "public",
                      id: depositInfo.address,
                      token: selectedAsset.id,
                      network: selectedNetwork.id,
                  })
                : null;

        if (!path) return;
        window.open(
            getAbsoluteTransferUrl(path),
            "_blank",
            "noopener,noreferrer",
        );
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

    // Poll confidential quote status for one-time addresses.
    // Status is best-effort — keep showing the address if the poll fails.
    const oneTimeStatusEnabled =
        step === "address" &&
        isConfidential &&
        depositSource === "public_wallet" &&
        !!depositInfo?.quoteDepositAddress;

    const { expiresAtMs: statusExpiresAtMs, isTerminal: statusIsTerminal } =
        useDepositAddressStatus({
            enabled: oneTimeStatusEnabled,
            accountId: treasuryId,
            depositAddress: depositInfo?.quoteDepositAddress,
            // Fresh quotes may miss history briefly — keep polling until used/expired.
            stopOnNotFound: false,
        });

    const oneTimeExpiresAtMs =
        statusExpiresAtMs ?? depositInfo?.expiresAtMs ?? null;

    const nowMs = useDepositExpiryClock(
        oneTimeStatusEnabled && !statusIsTerminal,
        oneTimeExpiresAtMs,
    );

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
            return buildConfidentialOriginNotices(t);
        }

        return buildPublicWalletOneTimeNotices(
            t,
            assetSymbol,
            networkDisplayName,
            {
                expiresAtMs: oneTimeExpiresAtMs,
                nowMs,
                locale,
            },
        );
    }, [
        isConfidential,
        depositSource,
        minDepositDisplay,
        assetSymbol,
        networkDisplayName,
        oneTimeExpiresAtMs,
        nowMs,
        locale,
        t,
    ]);

    const oneTimeAddressInactive =
        isConfidential &&
        depositSource === "public_wallet" &&
        (statusIsTerminal ||
            isDepositAddressExpired(oneTimeExpiresAtMs, nowMs));

    const addressTitle = useMemo(() => {
        if (!isConfidential) {
            return t("publicAddressTitle", {
                symbol: assetSymbol,
                network: networkDisplayName,
            });
        }
        if (depositSource === "confidential_user") {
            return t("confidentialNearcomTitle");
        }
        return t("oneTimeAddressTitle", {
            symbol: assetSymbol,
            network: networkDisplayName,
        });
    }, [isConfidential, depositSource, assetSymbol, networkDisplayName, t]);

    const addressSubtitle = useMemo(() => {
        if (!isConfidential) return t("publicAddressSubtitle");
        if (depositSource === "confidential_user") {
            return t("confidentialNearcomSubtitle");
        }
        return t("oneTimeAddressSubtitle");
    }, [isConfidential, depositSource, t]);

    return (
        <div className="flex w-full flex-col gap-4">
            {showSelectSlotWideBanner && (
                <SlotWarning slot="deposit" className="mb-0" />
            )}

            {step === "select" && isConfidential && (
                <DepositSourceCards
                    value={depositSource}
                    onChange={handleSourceChange}
                />
            )}

            {step === "select" && showAssetNetworkForm && (
                <DepositAssetNetworkForm
                    form={form}
                    selectedAsset={selectedAsset}
                    selectedNetwork={selectedNetwork}
                    selectorsDisabled={depositSelectorsDisabled}
                    isAssetsPending={isAssetsPending}
                    showTopBorder={isConfidential}
                    separateFields={isConfidential}
                    onOpenAssetModal={() => setModalType("asset")}
                    onOpenNetworkModal={() => setModalType("network")}
                    tokenWarning={
                        showSelectTokenPausedInline ? (
                            <WarningMessage
                                variant="inline"
                                message={inlineScopedMessage}
                                className="text-sm whitespace-normal"
                            />
                        ) : null
                    }
                    networkWarning={
                        showSelectNetworkPausedInline ? (
                            <WarningMessage
                                variant="inline"
                                message={inlineScopedMessage}
                                className="text-sm whitespace-normal"
                            />
                        ) : null
                    }
                />
            )}

            {/* Token + one network paused (public wallet) → banner below selectors */}
            {showSelectTokenNetworkBannerBelow && (
                <SlotWarning
                    slot={depositScopeWarning?.slot ?? "deposit"}
                    token={depositScopeWarning?.token ?? undefined}
                    network={depositScopeWarning?.network ?? undefined}
                    action="deposit"
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
                    className="border-t border-general-border pt-6"
                    title={t("internalAddressTitle")}
                    items={[
                        {
                            id: "receives-only",
                            tone: "success",
                            content: t("receivesOnlyConfidential"),
                            subtext: t("receivesOnlyConfidentialSub"),
                        },
                        {
                            id: "anything-else",
                            tone: "danger",
                            content: t("anythingElseLost"),
                            subtext: t("anythingElseLostSub"),
                        },
                    ]}
                    checkboxLabel={t("confidentialAckCheckbox")}
                    checked={hasAcknowledged}
                    onCheckedChange={setHasAcknowledged}
                    ctaLabel={t("showAddress")}
                    onCta={handleShowConfidentialAddress}
                    disabled={isDepositSlotWideBlocked}
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
                    // Sputnik-dao treasury id — plain text, no highlight.
                    preferPlainAddress={
                        isConfidential && depositSource === "confidential_user"
                    }
                    notices={addressNotices}
                    onShare={handleShare}
                    showShare={!oneTimeAddressInactive}
                    onCreateNewAddress={
                        isConfidential && depositSource === "public_wallet"
                            ? handleCreateNewAddress
                            : undefined
                    }
                    createNewAddressDisabled={isLoadingAddress}
                    onBack={handleBackFromAddress}
                    headerSlot={
                        showAddressWarningBanner ? (
                            <SlotWarning
                                slot={depositScopeWarning?.slot ?? "deposit"}
                                token={depositScopeWarning?.token ?? undefined}
                                network={
                                    depositScopeWarning?.network ?? undefined
                                }
                                action="deposit"
                            />
                        ) : undefined
                    }
                />
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
                renderContent={(item, { searchQuery }) => {
                    const option = item as SelectOption;
                    const networkLabel = getNetworkDisplayName(
                        option.name || option.symbol || "",
                    );
                    return (
                        <div className="flex-1 text-left">
                            <div
                                className={cn(
                                    "font-semibold",
                                    getNetworkDisplayCaseClass(option.name),
                                )}
                            >
                                <HighlightedText
                                    text={networkLabel}
                                    query={searchQuery}
                                />
                            </div>
                            {option.description && (
                                <div className="text-xs text-muted-foreground font-normal">
                                    <HighlightedText
                                        text={option.description}
                                        query={searchQuery}
                                    />
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
        </div>
    );
}

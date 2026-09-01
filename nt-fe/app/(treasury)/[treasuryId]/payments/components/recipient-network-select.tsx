"use client";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { SelectModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { Button } from "@/components/button";
import { HighlightedText } from "@/components/highlighted-text";
import { Icon } from "@/components/icon";
import { InputBlock } from "@/components/input-block";
import {
    EmptySelectorIcon,
    selectorTriggerClassName,
} from "@/components/selector-field";
import { getNetworkDisplayName } from "@/components/token-display";
import type { Token } from "@/components/token-input";
import { WarningMessage } from "@/components/warning-message";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import { NEAR_CHAIN_ICONS, NEAR_COM_ICON } from "@/constants/token";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { useMergedTokens } from "@/hooks/use-merged-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { findBridgeAssetForTokenMatch } from "@/lib/bridge-asset-resolver";
import {
    getLocalizedNetworkDisplayName,
    getNetworkDisplayCaseClass,
    isNearComNetwork,
} from "@/lib/intents-network";
import { pickDefaultDestinationNetwork } from "@/lib/pick-default-destination-network";
import { canAddressUseDestination } from "@/lib/recipient-address-rules";
import { buildSectionedOptions, type SectionRule } from "@/lib/section-rules";
import { cn } from "@/lib/utils";

export interface RecipientNetworkOption {
    id: string;
    name: string;
    description?: string;
    icon: string;
    /** Raw network name from bridge data (or "near" for near.com). Used to derive blockchain type. */
    networkName: string;
}

interface RecipientNetworkSelectProps {
    value: string;
    onChange: (networkId: string) => void;
    token: Token | null;
    /**
     * Recipient address entered by the user. Drives compatibility split in
     * the picker — networks whose address format doesn't match are surfaced
     * in a separate "Incompatible" section and disabled.
     */
    recipient: string;
    bridgeAssets: BridgeAsset[];
    isBridgeAssetsLoading?: boolean;
    sectionRules: SectionRule<RecipientNetworkRuleOption>[];
    /**
     * Fires when the user picks a network. Carries the raw network name so
     * callers can derive blockchain type (for downstream address validation).
     */
    onNetworkChange?: (option: RecipientNetworkOption) => void;
    warningMessage?: string | null;
    /** Highlights the network card when selection is required/missing. */
    invalid?: boolean;
    /** Error text shown under the network card. */
    errorMessage?: string | null;
    /**
     * When true (default), the picker stays disabled until a recipient
     * address is entered and filters/clears by address compatibility.
     * When false, every option is available immediately (no address gate).
     */
    requireRecipient?: boolean;
    /** Card treatment used by the bulk-payment flow. */
    appearance?: "default" | "card";
    /** Optional copy overrides for flows with different picker semantics. */
    label?: string;
    placeholder?: string;
    recipientRequiredPlaceholder?: string;
    modalTitle?: string;
    /**
     * Single send only. When a token is chosen, pick the destination with
     * the highest USD holding, else the only chain, else the first option.
     */
    autoSelect?: boolean;
    /** Display-only: selection cannot change (bulk edit). */
    locked?: boolean;
}

export type RecipientNetworkRuleOption = RecipientNetworkOption & {
    isCompatible: boolean;
};

function isAddressCompatibleWithNetwork(
    address: string,
    networkName: string,
    optionId?: string,
): boolean {
    // NEAR full check is async; the shared sync rules are enough for sectioning.
    return canAddressUseDestination({
        address,
        network: networkName,
        isNearComDestination: optionId === NEAR_COM_NETWORK_ID,
    });
}

function NetworkRow({
    option,
    disabled,
    highlightQuery,
}: {
    option: RecipientNetworkOption;
    disabled?: boolean;
    highlightQuery?: string;
}) {
    return (
        <div
            className={cn(
                "flex items-center gap-2 md:gap-3 w-full min-w-0",
                disabled && "opacity-50",
            )}
        >
            <img
                src={option.icon}
                alt={`${option.name} network`}
                className="size-6 md:size-8 shrink-0 overflow-hidden rounded-full object-cover"
            />
            <div className="flex flex-col items-start text-left min-w-0">
                <HighlightedText
                    text={option.name}
                    query={highlightQuery}
                    className={cn(
                        "text-sm md:text-base font-semibold truncate max-w-full",
                        getNetworkDisplayCaseClass(option.id),
                    )}
                />
                {option.description && (
                    <HighlightedText
                        text={option.description}
                        query={highlightQuery}
                        className="text-xs text-muted-foreground font-normal"
                    />
                )}
            </div>
        </div>
    );
}

export function RecipientNetworkSelect({
    value,
    onChange,
    token,
    recipient,
    bridgeAssets,
    isBridgeAssetsLoading = false,
    sectionRules,
    onNetworkChange,
    warningMessage,
    invalid = false,
    errorMessage = null,
    requireRecipient = true,
    appearance = "default",
    label,
    placeholder,
    recipientRequiredPlaceholder,
    modalTitle,
    autoSelect = false,
    locked = false,
}: RecipientNetworkSelectProps) {
    const t = useTranslations("recipientNetworkSelect");
    const tAddressBookTable = useTranslations("addressBookTable");
    const { isConfidential } = useTreasury();
    const { tokens: mergedTokens } = useMergedTokens({
        enabled: autoSelect,
    });
    const [open, setOpen] = useState(false);

    const nearComOption: RecipientNetworkOption = useMemo(
        () => ({
            id: NEAR_COM_NETWORK_ID,
            name: getLocalizedNetworkDisplayName({
                networkName: NEAR_COM_NETWORK_ID,
                networkLabel: tAddressBookTable("network"),
                fallbackName: "near.com",
            }),
            description: t("nearComDescription"),
            icon: NEAR_COM_ICON,
            networkName: NEAR_NETWORK_ID,
        }),
        [t, tAddressBookTable],
    );

    const bridgeAssetMatch = useMemo(
        () => findBridgeAssetForTokenMatch(bridgeAssets, token),
        [bridgeAssets, token],
    );

    const tokenNetworkOptions = useMemo((): RecipientNetworkOption[] => {
        // Native NEAR / NEAR FT: destination id is `near`, not `nep141:wrap.near`.
        // Check before bridge match — address "near" also resolves a bridge asset.
        if (
            token?.residency === "Ft" ||
            token?.residency === "Near" ||
            token?.address?.toLowerCase() === NEAR_NETWORK_ID
        ) {
            return [
                {
                    id: NEAR_NETWORK_ID,
                    name: getNetworkDisplayName(NEAR_NETWORK_ID),
                    icon: NEAR_CHAIN_ICONS.icon,
                    networkName: NEAR_NETWORK_ID,
                },
            ];
        }

        if (bridgeAssetMatch) {
            return bridgeAssetMatch.networks.map((network) => {
                const iconUrl = network.chainIcons
                    ? network.chainIcons.icon
                    : "";
                return {
                    id: network.id,
                    name: getNetworkDisplayName(network.name),
                    description:
                        isConfidential &&
                        getBlockchainType(network.name) === NEAR_NETWORK_ID
                            ? t("nearDescription")
                            : undefined,
                    icon: iconUrl,
                    networkName: network.name,
                };
            });
        }

        return [];
    }, [bridgeAssetMatch, isConfidential, t, token]);

    const availableOptions = useMemo(() => {
        // Stay empty until the token and its destinations are known. near.com
        // is a destination for every token, so offering it on its own during
        // load shows a selector that is already filled in (and auto-select
        // would settle on it) before the real destinations arrive.
        if (!token || isBridgeAssetsLoading) return [];

        const others = tokenNetworkOptions
            .filter((option) => option.id !== NEAR_COM_NETWORK_ID)
            .sort((a, b) => a.name.localeCompare(b.name));
        return [nearComOption, ...others];
    }, [isBridgeAssetsLoading, nearComOption, token, tokenNetworkOptions]);

    const tokenHoldings = useMemo(() => {
        if (!token) return [];
        const tokenAddress = token.address?.trim().toLowerCase();
        const tokenNetwork = token.network?.trim().toLowerCase();
        const tokenSymbol = token.symbol?.trim().toLowerCase();
        const asset = mergedTokens.find(
            (merged) =>
                merged.networks.some(
                    (network) =>
                        network.id.trim().toLowerCase() === tokenAddress &&
                        network.name.trim().toLowerCase() === tokenNetwork,
                ) || merged.symbol.trim().toLowerCase() === tokenSymbol,
        );
        return (asset?.networks ?? []).map((network) => ({
            id: network.id,
            name: network.name,
            balanceUSD: network.balanceUSD,
        }));
    }, [mergedTokens, token]);

    const selectedOption = useMemo(() => {
        if (!value) return null;
        return availableOptions.find((o) => o.id === value) ?? null;
    }, [availableOptions, value]);

    const enrichedOptions = useMemo(() => {
        return availableOptions.map((option) => ({
            ...option,
            isCompatible: requireRecipient
                ? isAddressCompatibleWithNetwork(
                      recipient,
                      option.networkName,
                      option.id,
                  )
                : true,
        }));
    }, [availableOptions, recipient, requireRecipient]);

    const compatibleOptions = useMemo(
        () => enrichedOptions.filter((option) => option.isCompatible),
        [enrichedOptions],
    );

    const sections = useMemo(() => {
        return buildSectionedOptions(enrichedOptions, sectionRules).map(
            (section) => ({
                title: section.title,
                options: section.options.map((option) => {
                    const { isCompatible: _ignored, ...rawOption } = option;
                    return {
                        id: option.id,
                        name: option.name,
                        icon: "",
                        disabled: option.disabled,
                        _option: rawOption,
                        _disabled: option.disabled,
                    };
                }),
            }),
        );
    }, [enrichedOptions, sectionRules]);

    const hasCompatibleNetwork = compatibleOptions.length > 0;
    const isDisabled =
        locked ||
        (requireRecipient
            ? !recipient || isBridgeAssetsLoading || !hasCompatibleNetwork
            : isBridgeAssetsLoading || availableOptions.length === 0);

    const prevRecipientRef = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    const onNetworkChangeRef = useRef(onNetworkChange);
    onChangeRef.current = onChange;
    onNetworkChangeRef.current = onNetworkChange;

    const tokenKey = token
        ? `${token.address ?? ""}:${token.network ?? ""}:${token.residency ?? ""}`
        : "";
    const prevTokenKeyRef = useRef<string | null>(null);
    const autoPickedRef = useRef(false);
    const userPickedRef = useRef(false);

    useEffect(() => {
        if (!autoSelect || locked || !token || availableOptions.length === 0)
            return;

        const tokenChanged = prevTokenKeyRef.current !== tokenKey;
        const hasUsdHoldings = tokenHoldings.some(
            (holding) => (holding.balanceUSD ?? 0) > 0,
        );

        if (tokenChanged) {
            const isFirstToken = prevTokenKeyRef.current === null;
            prevTokenKeyRef.current = tokenKey;
            userPickedRef.current = false;

            // Keep a dest already set for this token (URL / parent seed).
            if (
                isFirstToken &&
                value &&
                availableOptions.some((option) => option.id === value)
            ) {
                autoPickedRef.current = false;
                return;
            }
        } else if (userPickedRef.current || !autoPickedRef.current) {
            return;
        } else if (!hasUsdHoldings) {
            return;
        }

        const picked = pickDefaultDestinationNetwork(
            availableOptions,
            tokenHoldings,
        );
        if (!picked) return;
        autoPickedRef.current = true;
        if (picked.id === value) return;
        onChangeRef.current(picked.id);
        onNetworkChangeRef.current?.(picked);
    }, [
        autoSelect,
        availableOptions,
        locked,
        token,
        tokenHoldings,
        tokenKey,
        value,
    ]);

    // Drop the selected network when the *address* changes into a format it
    // can't take. Picking a network is the user's own choice, so it stands:
    // the form clears the recipient in response, and clearing the network here
    // as well would race that reset and leave both fields empty.
    useEffect(() => {
        if (locked) return;
        if (!recipient) {
            prevRecipientRef.current = "";
            return;
        }

        const recipientChanged = prevRecipientRef.current !== recipient;
        prevRecipientRef.current = recipient;
        if (!value) return;
        // Options aren't loaded yet — an unresolved selection means nothing.
        if (availableOptions.length === 0) return;

        if (!selectedOption) {
            onChangeRef.current("");
            return;
        }

        // Without the address gate every option is offered, so there is no
        // compatibility to enforce.
        if (!requireRecipient || !recipientChanged) return;

        if (
            !isAddressCompatibleWithNetwork(
                recipient,
                selectedOption.networkName,
                selectedOption.id,
            )
        ) {
            onChangeRef.current("");
        }
    }, [
        availableOptions.length,
        locked,
        recipient,
        requireRecipient,
        selectedOption,
        value,
    ]);

    const placeholderText = requireRecipient
        ? !recipient
            ? (recipientRequiredPlaceholder ?? t("enterAddressFirst"))
            : // While destinations load there is nothing to be incompatible with.
              !hasCompatibleNetwork && !isBridgeAssetsLoading
              ? t("noCompatibleNetwork")
              : (placeholder ?? t("placeholder"))
        : (placeholder ?? t("placeholder"));

    const selectorButton =
        appearance === "card" ? (
            <Button
                type="button"
                variant="unstyled"
                onClick={() => setOpen(true)}
                disabled={isDisabled}
                className={cn(
                    selectorTriggerClassName,
                    invalid && "border-destructive bg-destructive/5",
                    isDisabled && !locked && "opacity-100",
                    locked && "opacity-60",
                )}
            >
                {selectedOption ? (
                    <img
                        src={selectedOption.icon}
                        alt=""
                        className="size-10 shrink-0 overflow-hidden rounded-full object-cover"
                    />
                ) : (
                    <EmptySelectorIcon />
                )}
                <span className="flex min-w-0 flex-1 flex-col items-start gap-px text-left">
                    <span className="text-sm font-medium leading-normal text-muted-foreground">
                        {label ?? t("label")}
                    </span>
                    <span
                        className={cn(
                            "max-w-full truncate text-base leading-tight",
                            locked || !selectedOption
                                ? "font-medium text-muted-foreground"
                                : "font-semibold text-foreground",
                            selectedOption &&
                                getNetworkDisplayCaseClass(selectedOption.id),
                        )}
                    >
                        {selectedOption ? selectedOption.name : placeholderText}
                    </span>
                </span>
                {selectedOption && isNearComNetwork(selectedOption.id) && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-foreground px-2.5 py-1.5">
                        <img
                            src={NEAR_COM_ICON}
                            alt=""
                            className="size-3.5 overflow-hidden rounded-full object-cover"
                        />
                        <span className="text-xs font-semibold text-[#00EC97]">
                            {t("internalTag")}
                        </span>
                    </span>
                )}
                <Icon
                    icon={ArrowDown01Icon}
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                />
            </Button>
        ) : (
            <InputBlock
                title={label ?? t("label")}
                interactive={!isDisabled}
                disabled={isDisabled}
                invalid={invalid}
            >
                <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOpen(true)}
                    disabled={isDisabled}
                    className="w-full h-11 md:h-12 justify-between px-0! hover:bg-transparent dark:hover:bg-transparent focus-visible:bg-transparent dark:focus-visible:bg-transparent disabled:opacity-100"
                >
                    {selectedOption ? (
                        <NetworkRow option={selectedOption} />
                    ) : (
                        <span className="text-base md:text-xl! font-normal text-muted-foreground truncate">
                            {placeholderText}
                        </span>
                    )}
                    <Icon
                        icon={ArrowDown01Icon}
                        className="text-muted-foreground ml-auto shrink-0"
                    />
                </Button>
                {warningMessage && (
                    <WarningMessage
                        variant="inline"
                        message={warningMessage}
                        className="text-sm"
                    />
                )}
            </InputBlock>
        );

    return (
        <>
            {selectorButton}
            {errorMessage && (
                <p className="text-sm text-destructive mt-1">{errorMessage}</p>
            )}

            <SelectModal
                isOpen={open}
                onClose={() => setOpen(false)}
                title={modalTitle ?? t("title")}
                options={[]}
                sections={sections}
                selectedId={value}
                onSelect={(option) => {
                    const rich = option as unknown as {
                        _option: RecipientNetworkOption;
                        _disabled?: boolean;
                    };
                    if (rich._disabled) return;
                    userPickedRef.current = true;
                    autoPickedRef.current = false;
                    onChange(rich._option.id);
                    onNetworkChange?.(rich._option);
                    setOpen(false);
                }}
                renderIcon={(option, { searchQuery }) => {
                    const rich = option as unknown as {
                        _option: RecipientNetworkOption;
                        _disabled?: boolean;
                    };
                    return (
                        <NetworkRow
                            option={rich._option}
                            disabled={rich._disabled}
                            highlightQuery={searchQuery}
                        />
                    );
                }}
                renderContent={() => null}
            />
        </>
    );
}

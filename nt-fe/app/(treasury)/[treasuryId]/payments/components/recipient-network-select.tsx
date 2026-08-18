"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { SelectModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { Button } from "@/components/button";
import { InputBlock } from "@/components/input-block";
import { WarningMessage } from "@/components/warning-message";
import { getNetworkDisplayName } from "@/components/token-display";
import type { Token } from "@/components/token-input";
import { NEAR_NETWORK_ID, NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import {
    getNetworkDisplayCaseClass,
    getLocalizedNetworkDisplayName,
} from "@/lib/intents-network";
import { NEAR_COM_ICON, NEAR_CHAIN_ICONS } from "@/constants/token";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { isValidAddress } from "@/lib/address-validation";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { parseNearComAddress } from "@/lib/nearcom-address";
import { isValidNearAddressFormat } from "@/lib/near-validation";
import { buildSectionedOptions, type SectionRule } from "@/lib/section-rules";
import { findBridgeAssetForTokenMatch } from "@/lib/bridge-asset-resolver";
import { HighlightedText } from "@/components/highlighted-text";
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
}

export type RecipientNetworkRuleOption = RecipientNetworkOption & {
    isCompatible: boolean;
};

function isAddressCompatibleWithNetwork(
    address: string,
    networkName: string,
    optionId?: string,
): boolean {
    if (!address) return true;
    const { hasPrefix, accountId } = parseNearComAddress(address);

    // near.com only for nearcom:<validNear>. Never compatible otherwise.
    if (optionId === NEAR_COM_NETWORK_ID) {
        return hasPrefix && !!accountId && isValidNearAddressFormat(accountId);
    }

    // Original per-chain format checks (ignore nearcom: — that route is above).
    if (hasPrefix) return false;

    const blockchain = getBlockchainType(networkName);
    if (blockchain === "unknown") {
        return false;
    }
    if (blockchain === NEAR_NETWORK_ID) {
        // NEAR full check is async; sync format check is enough for sectioning.
        return isValidNearAddressFormat(accountId);
    }
    return isValidAddress(accountId, blockchain);
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
                className={cn(
                    "size-6 md:size-8 rounded-full object-cover shrink-0",
                    option.networkName.toLowerCase() === NEAR_NETWORK_ID &&
                        "p-1",
                )}
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
}: RecipientNetworkSelectProps) {
    const t = useTranslations("recipientNetworkSelect");
    const tAddressBookTable = useTranslations("addressBookTable");
    const { isConfidential } = useTreasury();
    const [open, setOpen] = useState(false);

    const nearComOption: RecipientNetworkOption = useMemo(
        () => ({
            id: NEAR_COM_NETWORK_ID,
            name: getLocalizedNetworkDisplayName({
                networkName: NEAR_COM_NETWORK_ID,
                networkLabel: tAddressBookTable("network"),
                fallbackName: "near.com",
            }),
            description: isConfidential
                ? t("nearComDescription")
                : t("nearComDescriptionPublic"),
            icon: NEAR_COM_ICON,
            networkName: NEAR_NETWORK_ID,
        }),
        [isConfidential, t, tAddressBookTable],
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
        const { hasPrefix, accountId } = parseNearComAddress(recipient);
        const isNearComRecipient =
            hasPrefix && !!accountId && isValidNearAddressFormat(accountId);

        // nearcom:<validNear> → near.com only (public + confidential).
        // Never listed as a free option — only when the recipient uses the prefix.
        if (isNearComRecipient) {
            return [nearComOption];
        }

        return [...tokenNetworkOptions].sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    }, [nearComOption, recipient, tokenNetworkOptions]);

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
    const isDisabled = requireRecipient
        ? !recipient || isBridgeAssetsLoading || !hasCompatibleNetwork
        : isBridgeAssetsLoading || availableOptions.length === 0;

    // Only clear when the user wipes the address. Do not clear on
    // incompatible network during typing — the payments page reseeds
    // destination from address shape, and clear↔seed loops hard.
    // Keep onChange in a ref so an inline parent callback can't re-fire this.
    const hadRecipientRef = useRef(false);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => {
        if (!requireRecipient) return;
        if (recipient) {
            hadRecipientRef.current = true;
            return;
        }
        if (hadRecipientRef.current && value) {
            hadRecipientRef.current = false;
            onChangeRef.current("");
        }
    }, [recipient, value, requireRecipient]);

    const placeholderText = requireRecipient
        ? !recipient
            ? t("enterAddressFirst")
            : !hasCompatibleNetwork
              ? t("noCompatibleNetwork")
              : t("placeholder")
        : t("placeholder");

    return (
        <>
            <InputBlock
                title={t("label")}
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
                    {selectedOption && !isDisabled ? (
                        <NetworkRow option={selectedOption} />
                    ) : (
                        <span className="text-base md:text-xl! font-normal text-muted-foreground truncate">
                            {placeholderText}
                        </span>
                    )}
                    <ChevronDown className="size-5 text-muted-foreground ml-auto shrink-0" />
                </Button>
                {warningMessage && (
                    <WarningMessage
                        variant="inline"
                        message={warningMessage}
                        className="text-sm"
                    />
                )}
            </InputBlock>
            {errorMessage && (
                <p className="text-sm text-destructive mt-1">{errorMessage}</p>
            )}

            <SelectModal
                isOpen={open}
                onClose={() => setOpen(false)}
                title={t("title")}
                options={[]}
                sections={sections}
                selectedId={value}
                onSelect={(option) => {
                    const rich = option as unknown as {
                        _option: RecipientNetworkOption;
                        _disabled?: boolean;
                    };
                    if (rich._disabled) return;
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

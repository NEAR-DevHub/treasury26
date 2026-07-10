"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
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
import { isValidNearAddressFormat } from "@/lib/near-validation";
import { buildSectionedOptions, type SectionRule } from "@/lib/section-rules";
import { findBridgeAssetForTokenMatch } from "@/lib/bridge-asset-resolver";
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
}

export type RecipientNetworkRuleOption = RecipientNetworkOption & {
    isCompatible: boolean;
};

function isAddressCompatibleWithNetwork(
    address: string,
    networkName: string,
): boolean {
    if (!address) return true;
    const blockchain = getBlockchainType(networkName);
    if (blockchain === "unknown") {
        return false;
    }
    if (blockchain === NEAR_NETWORK_ID) {
        // NEAR full check is async; sync format check is enough for sectioning.
        return isValidNearAddressFormat(address);
    }
    return isValidAddress(address, blockchain);
}

function NetworkRow({
    option,
    disabled,
}: {
    option: RecipientNetworkOption;
    disabled?: boolean;
}) {
    return (
        <div
            className={cn(
                "flex items-center gap-3 w-full",
                disabled && "opacity-50",
            )}
        >
            <img
                src={option.icon}
                alt={`${option.name} network`}
                className={cn(
                    "size-8 rounded-full object-cover",
                    option.networkName.toLowerCase() === NEAR_NETWORK_ID &&
                        "p-1",
                )}
            />
            <div className="flex flex-col items-start text-left">
                <span
                    className={cn(
                        "text-base font-semibold",
                        getNetworkDisplayCaseClass(option.id),
                    )}
                >
                    {option.name}
                </span>
                {option.description && (
                    <span className="text-xs text-muted-foreground font-normal">
                        {option.description}
                    </span>
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
            description: isConfidential ? t("nearComDescription") : undefined,
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

        // Native NEAR FTs can be transferred on NEAR network
        if (token?.residency === "Ft") {
            return [
                {
                    id: NEAR_NETWORK_ID,
                    name: getNetworkDisplayName(NEAR_NETWORK_ID),
                    icon: NEAR_CHAIN_ICONS.icon,
                    networkName: NEAR_NETWORK_ID,
                },
            ];
        }

        return [];
    }, [bridgeAssetMatch, isConfidential, t, token]);

    const availableOptions = useMemo(() => {
        const options = isConfidential
            ? [...tokenNetworkOptions, nearComOption]
            : tokenNetworkOptions;
        return [...options].sort((a, b) => a.name.localeCompare(b.name));
    }, [isConfidential, nearComOption, tokenNetworkOptions]);

    const selectedOption = useMemo(() => {
        if (!value) return null;
        if (value === NEAR_COM_NETWORK_ID) return nearComOption;
        return availableOptions.find((o) => o.id === value) ?? null;
    }, [availableOptions, nearComOption, value]);

    const enrichedOptions = useMemo(() => {
        return availableOptions.map((option) => ({
            ...option,
            isCompatible: isAddressCompatibleWithNetwork(
                recipient,
                option.networkName,
            ),
        }));
    }, [availableOptions, recipient]);

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
        !recipient || isBridgeAssetsLoading || !hasCompatibleNetwork;

    // Clear the selection when the address no longer matches it (e.g. user
    // edited the address into a different chain's format).
    useEffect(() => {
        if (!value) return;
        if (availableOptions.length === 0) return;
        if (compatibleOptions.some((o) => o.id === value)) return;
        onChange("");
    }, [value, availableOptions, compatibleOptions, onChange]);

    const placeholderText = !recipient
        ? t("enterAddressFirst")
        : !hasCompatibleNetwork
          ? t("noCompatibleNetwork")
          : t("placeholder");

    return (
        <>
            <InputBlock
                title={t("label")}
                interactive={!isDisabled}
                disabled={isDisabled}
                invalid={false}
            >
                <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOpen(true)}
                    disabled={isDisabled}
                    className="w-full h-12 justify-between px-0! hover:bg-transparent dark:hover:bg-transparent focus-visible:bg-transparent dark:focus-visible:bg-transparent disabled:opacity-100"
                >
                    {selectedOption && !isDisabled ? (
                        <NetworkRow option={selectedOption} />
                    ) : (
                        <span className="text-xl! font-normal text-muted-foreground">
                            {placeholderText}
                        </span>
                    )}
                    <ChevronDown className="size-5 text-muted-foreground ml-auto" />
                </Button>
                {warningMessage && (
                    <WarningMessage
                        variant="inline"
                        message={warningMessage}
                        className="text-sm"
                    />
                )}
            </InputBlock>

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
                renderIcon={(option) => {
                    const rich = option as unknown as {
                        _option: RecipientNetworkOption;
                        _disabled?: boolean;
                    };
                    return (
                        <NetworkRow
                            option={rich._option}
                            disabled={rich._disabled}
                        />
                    );
                }}
                renderContent={() => null}
            />
        </>
    );
}

"use client";

import { ArrowDown01Icon, Wallet03Icon } from "@hugeicons/core-free-icons";
import Gleap from "gleap";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    type Control,
    type FieldValues,
    type Path,
    type PathValue,
    useFormContext,
    useWatch,
} from "react-hook-form";
import AccountInput from "@/components/account-input";
import { Button } from "@/components/button";
import {
    CreateRequestButton,
    type PermissionRequirement,
} from "@/components/create-request-button";
import { Icon } from "@/components/icon";
import { InfoAlert } from "@/components/info-alert";
import { selectorTriggerClassName } from "@/components/selector-field";
import { getNetworkDisplayName } from "@/components/token-display";
import { type Token, TokenInput } from "@/components/token-input";
import TokenSelect, { type SelectedTokenData } from "@/components/token-select";
import { FormField } from "@/components/ui/form";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import {
    type AddressBookEntry,
    addressBookEntryMatchesNetwork,
    findAddressBookEntry,
    formatAddressBookDisplayAddress,
    useAddressBook,
} from "@/features/address-book";
import { type ChainInfo, useChains } from "@/features/address-book/chains";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { formatShortAddress } from "@/lib/format-short-address";
import { isNearComNetwork } from "@/lib/intents-network";
import { hasNearComAddressPrefix } from "@/lib/nearcom-address";
import {
    inferRecipientBlockchain,
    resolveRecipientBlockchain,
} from "@/lib/recipient-address-rules";
import type { SectionRule } from "@/lib/section-rules";
import {
    type RecipientNetworkRuleOption,
    RecipientNetworkSelect,
} from "./recipient-network-select";
import { RecipientSelectModal } from "./recipient-select-modal";

interface PaymentFormSectionProps<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>,
> {
    control: Control<TFieldValues>;
    amountName: Path<TFieldValues>;
    tokenName: TTokenPath extends Path<TFieldValues>
        ? NonNullable<PathValue<TFieldValues, TTokenPath>> extends Token
            ? TTokenPath
            : never
        : never;
    recipientName: Path<TFieldValues>;

    tokenLocked?: boolean;
    /**
     * Recipient is fixed by the caller (shown read-only, no validation or
     * address book). Used by public-to-confidential moves where the DAO
     * itself is the recipient.
     */
    recipientLocked?: boolean;
    /** Balance/price come from the form token, not the treasury assets. */
    balanceFromToken?: boolean;
    /** Permission(s) required to submit; defaults to `transfer` AddProposal. */
    savePermissions?: PermissionRequirement | PermissionRequirement[];
    feeErrorMessage?: string | null;
    networkFee?: string | null;
    showRestrictedRecipientAlert?: boolean;

    saveButtonText: string;
    onSave: () => void;
    isSubmitting?: boolean;
    onAmountInput?: () => void;
    onMaxSet?: (maxAmount: string) => void;
    onAddressBookSelectionChange?: (isFromAddressBook: boolean) => void;
    /**
     * Form field path for the destination network id. When provided (and not
     * explicitly hidden), renders the recipient network selector.
     */
    destinationNetworkName?: Path<TFieldValues>;
    /**
     * Form field path for the raw network name. Persisted so callers can
     * derive blockchain type downstream (review step, fees, contact filter).
     */
    destinationNetworkNameFieldName?: Path<TFieldValues>;
    /** Hide recipient network selector (e.g. bulk payments). Default false. */
    hideRecipientNetwork?: boolean;
    /** Show destination as a disabled card (bulk edit). */
    destinationLocked?: boolean;
    /**
     * When the network selector is hidden (bulk), validate the recipient and
     * filter the address book against this receive-network name instead of
     * defaulting to NEAR / the send token's chain. Used by confidential bulk
     * where receive network can differ from the source token.
     */
    recipientNetworkOverride?: string;
    /**
     * When true, the recipient must be `nearcom:` plus a valid NEAR account.
     * Used by bulk edit when the destination id is not a form field.
     */
    requireNearComPrefix?: boolean;
    bridgeAssets?: BridgeAsset[];
    isBridgeAssetsLoading?: boolean;
    sendWarningMessage?: string | null;
    recipientNetworkWarningMessage?: string | null;
    /** True when payments are blocked by a critical warning (not warning/info). */
    slotBlocked?: boolean;
    /**
     * When true (default), TokenSelect picks highest-USD owned → USDC NEAR.
     * Set false when the page seeds from ?token= / ?networks=.
     */
    tokenAutoSelect?: boolean;
    balanceOverrideRaw?: string | null;
    /** Live quote USD used to confirm the amount after price→token conversion. */
    usdValueOverride?: number | null;
}

export function PaymentFormSection<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>,
>({
    control,
    amountName,
    tokenName,
    recipientName,
    tokenLocked = false,
    recipientLocked = false,
    balanceFromToken = false,
    savePermissions = { kind: "transfer", action: "AddProposal" },
    feeErrorMessage = null,
    networkFee = null,
    showRestrictedRecipientAlert = false,
    saveButtonText,
    onSave,
    isSubmitting = false,
    onAmountInput,
    onMaxSet,
    onAddressBookSelectionChange,
    destinationNetworkName,
    destinationNetworkNameFieldName,
    hideRecipientNetwork = false,
    destinationLocked = false,
    recipientNetworkOverride,
    requireNearComPrefix: requireNearComPrefixProp = false,
    bridgeAssets = [],
    isBridgeAssetsLoading = false,
    sendWarningMessage,
    recipientNetworkWarningMessage,
    slotBlocked = false,
    tokenAutoSelect = true,
    balanceOverrideRaw = null,
    usdValueOverride = null,
}: PaymentFormSectionProps<TFieldValues, TTokenPath>) {
    const t = useTranslations("paymentFormSection");
    const tPay = useTranslations("payments");
    const tRecipientNetwork = useTranslations("recipientNetworkSelect");
    const { isConfidential } = useTreasury();
    const { setValue, setError, clearErrors } = useFormContext<TFieldValues>();
    const [isRecipientValid, setIsRecipientValid] = useState(false);
    const [isValidatingRecipient, setIsValidatingRecipient] = useState(false);
    const [isContactModalOpen, setIsContactModalOpen] = useState(false);
    const [selectedContact, setSelectedContact] =
        useState<AddressBookEntry | null>(null);
    const { data: addressBook = [] } = useAddressBook();
    const { data: chains = [] } = useChains();

    // Stable identity: TokenSelect memoizes its list on this callback.
    const filterIntentsOnly = useCallback(
        (tok: { residency?: string | null }) =>
            (tok.residency || "").toLowerCase() === "intents",
        [],
    );

    const chainMap = useMemo(() => {
        const map = new Map<string, ChainInfo>();
        for (const chain of chains) map.set(chain.key, chain);
        return map;
    }, [chains]);

    const watched = useWatch({
        control,
        name: [
            tokenName,
            recipientName,
            ...(destinationNetworkName ? [destinationNetworkName] : []),
            ...(destinationNetworkNameFieldName
                ? [destinationNetworkNameFieldName]
                : []),
        ] as Path<TFieldValues>[],
    }) as unknown as [
        Token | null,
        string,
        string | undefined,
        string | undefined,
    ];
    const token = watched[0];
    const recipient = (watched[1] ?? "") as string;
    const destinationNetworkId = destinationNetworkName
        ? ((watched[2] ?? "") as string)
        : "";
    const selectedNetworkName = ((destinationNetworkName
        ? (watched[3] ?? "")
        : (watched[2] ?? "")) ||
        recipientNetworkOverride ||
        "") as string;
    // Bulk and locked-destination flows fix the network upstream, so there the
    // address is judged against it. When the user picks the destination
    // themselves the address comes first and is judged on its own chain.
    const validateAgainstDestination =
        hideRecipientNetwork || destinationLocked;
    const requireNearComPrefix = validateAgainstDestination
        ? requireNearComPrefixProp || isNearComNetwork(destinationNetworkId)
        : // Address-led: the prefix picks near.com, so it is always allowed
          // and never demanded by the current selection.
          hasNearComAddressPrefix(recipient);
    // Picker stores the chain name (`near`) separately from the option id
    // (`near.com`). Address-book matching must use the option id or near.com
    // contacts are filtered as bare NEAR.
    const addressBookNetworkName = requireNearComPrefix
        ? NEAR_COM_NETWORK_ID
        : selectedNetworkName;
    const amountValue = useWatch({
        control,
        name: amountName,
    }) as unknown as string | number | undefined;
    const setRecipientValue = useCallback(
        (value: PathValue<TFieldValues, Path<TFieldValues>>) => {
            setValue(recipientName, value, {
                shouldDirty: true,
                shouldTouch: true,
                shouldValidate: true,
            });
        },
        [recipientName, setValue],
    );

    const networkSectionRules = useMemo<
        SectionRule<RecipientNetworkRuleOption>[]
    >(() => {
        const contactSet = new Set(selectedContact?.networks ?? []);
        if (contactSet.size > 0) {
            return [
                {
                    title: tRecipientNetwork("fromAddressBook"),
                    filter: (option) =>
                        option.isCompatible &&
                        contactSet.has(option.networkName),
                },
                {
                    title: tRecipientNetwork("otherAvailable"),
                    filter: (option) =>
                        option.isCompatible &&
                        !contactSet.has(option.networkName),
                },
                {
                    title: tRecipientNetwork("incompatible"),
                    filter: (option) => !option.isCompatible,
                    disabled: true,
                },
            ];
        }

        return [
            {
                title: tRecipientNetwork("available"),
                filter: (option) => option.isCompatible,
            },
            {
                title: tRecipientNetwork("incompatible"),
                filter: (option) => !option.isCompatible,
                disabled: true,
            },
        ];
    }, [selectedContact, tRecipientNetwork]);

    const inferredRecipientChain = useMemo(
        () => inferRecipientBlockchain(recipient),
        [recipient],
    );

    // Bulk validates against the receive network (override or form field),
    // falling back to NEAR. Elsewhere the address names its own chain, so a
    // recipient on another network is never rejected by the current pick.
    const blockchainType = useMemo(() => {
        if (!validateAgainstDestination) {
            return inferredRecipientChain ?? "unknown";
        }
        if (selectedNetworkName) {
            return resolveRecipientBlockchain(selectedNetworkName);
        }
        return NEAR_NETWORK_ID;
    }, [
        inferredRecipientChain,
        selectedNetworkName,
        validateAgainstDestination,
    ]);

    const hasSelectedNetwork = !!selectedNetworkName;
    const hasValidAmount = useMemo(() => {
        if (amountValue === null || amountValue === undefined) return false;
        const parsed = Number(amountValue);
        return Number.isFinite(parsed) && parsed > 0;
    }, [amountValue]);

    // Sync fee coverage error into the amount field.
    useEffect(() => {
        if (!feeErrorMessage || showRestrictedRecipientAlert) {
            clearErrors(amountName);
            return;
        }

        setError(amountName, { type: "manual", message: feeErrorMessage });
    }, [
        amountName,
        clearErrors,
        feeErrorMessage,
        setError,
        showRestrictedRecipientAlert,
    ]);

    // When a contact is selected, sync the address into the form field
    useEffect(() => {
        if (selectedContact) {
            setRecipientValue(
                formatAddressBookDisplayAddress(selectedContact) as PathValue<
                    TFieldValues,
                    Path<TFieldValues>
                >,
            );
        }
    }, [selectedContact, setRecipientValue]);

    useEffect(() => {
        onAddressBookSelectionChange?.(!!selectedContact);
    }, [selectedContact, onAddressBookSelectionChange]);

    // For bulk (no network selector), drop a selected contact whose networks
    // don't match the locked token's chain. With the selector visible, the
    // user picks the network themselves so cross-chain contacts stay.
    useEffect(() => {
        if (!hideRecipientNetwork) return;
        if (!selectedContact) return;
        const isCompatible = addressBookEntryMatchesNetwork(
            selectedContact,
            addressBookNetworkName,
            blockchainType,
        );
        if (!isCompatible) {
            setSelectedContact(null);
            setRecipientValue(
                "" as PathValue<TFieldValues, Path<TFieldValues>>,
            );
            setIsRecipientValid(false);
        }
    }, [
        hideRecipientNetwork,
        blockchainType,
        addressBookNetworkName,
        selectedContact,
        setRecipientValue,
    ]);

    const filteredAddressBook = useMemo(
        () =>
            hideRecipientNetwork
                ? addressBook.filter((entry) =>
                      addressBookEntryMatchesNetwork(
                          entry,
                          addressBookNetworkName,
                          blockchainType,
                      ),
                  )
                : addressBook,
        [
            addressBook,
            addressBookNetworkName,
            blockchainType,
            hideRecipientNetwork,
        ],
    );

    // When recipient is pre-filled (e.g. stepping back from review), check if it matches an address book entry
    useEffect(() => {
        if (!recipient || selectedContact || filteredAddressBook.length === 0)
            return;
        const match = findAddressBookEntry(filteredAddressBook, recipient);
        if (match) setSelectedContact(match);
    }, [recipient, filteredAddressBook, selectedContact]);

    const networkDisplayName = selectedNetworkName
        ? getNetworkDisplayName(selectedNetworkName)
        : null;

    // `unknown` makes AccountInput accept any non-empty string, so an address
    // that matches no supported chain is rejected here instead.
    const isRecipientUnrecognized =
        !validateAgainstDestination && !!recipient && !inferredRecipientChain;

    const isSaveDisabled =
        slotBlocked ||
        !hasValidAmount ||
        !recipient ||
        (!recipientLocked && !isRecipientValid) ||
        isRecipientUnrecognized ||
        (!hideRecipientNetwork && !hasSelectedNetwork) ||
        showRestrictedRecipientAlert ||
        isValidatingRecipient ||
        (!!feeErrorMessage && !showRestrictedRecipientAlert) ||
        isSubmitting;

    const handleOpenProductSupport = useCallback(() => {
        Gleap.open();
    }, []);

    const restrictedAlertNode = showRestrictedRecipientAlert ? (
        <InfoAlert
            message={
                <div className="text-sm">
                    <div className="font-semibold">
                        {t("restrictedRecipientTitle")}
                    </div>
                    <div>
                        {t.rich("restrictedRecipientMessage", {
                            link: (chunks) => (
                                <Button
                                    type="button"
                                    variant="link"
                                    className="h-auto p-0 underline underline-offset-2 text-inherit hover:text-inherit font-normal!"
                                    onClick={handleOpenProductSupport}
                                >
                                    {chunks}
                                </Button>
                            ),
                        })}
                    </div>
                </div>
            }
        />
    ) : null;

    const destinationNetworkField =
        !hideRecipientNetwork && destinationNetworkName ? (
            <FormField
                control={control}
                name={destinationNetworkName}
                render={({ field }) => (
                    <RecipientNetworkSelect
                        value={(field.value as string | undefined) ?? ""}
                        recipient={recipient}
                        sectionRules={networkSectionRules}
                        appearance="card"
                        locked={destinationLocked}
                        label={tRecipientNetwork("label")}
                        placeholder={tRecipientNetwork("placeholder")}
                        onChange={(id) => {
                            field.onChange(id);
                            if (!id && destinationNetworkNameFieldName) {
                                setValue(
                                    destinationNetworkNameFieldName,
                                    "" as PathValue<
                                        TFieldValues,
                                        Path<TFieldValues>
                                    >,
                                    { shouldDirty: true },
                                );
                            }
                        }}
                        onNetworkChange={(opt) => {
                            if (destinationNetworkNameFieldName) {
                                setValue(
                                    destinationNetworkNameFieldName,
                                    opt.networkName as PathValue<
                                        TFieldValues,
                                        Path<TFieldValues>
                                    >,
                                    { shouldDirty: true },
                                );
                            }
                        }}
                        bridgeAssets={bridgeAssets}
                        token={token}
                        isBridgeAssetsLoading={isBridgeAssetsLoading}
                        warningMessage={recipientNetworkWarningMessage}
                    />
                )}
            />
        ) : null;

    const shortRecipient = recipient ? formatShortAddress(recipient) : "";
    const recipientRow = (
        <span className="flex min-w-0 flex-1 flex-col items-start gap-px">
            <span
                className={
                    selectedContact
                        ? "max-w-full truncate text-base font-medium leading-tight text-foreground"
                        : "text-sm font-medium leading-normal text-muted-foreground"
                }
            >
                {selectedContact
                    ? selectedContact.name
                    : tPay("recipientLabel")}
            </span>
            <span
                className={
                    selectedContact
                        ? "max-w-full truncate text-sm font-medium leading-normal text-general-secondary-foreground"
                        : "max-w-full truncate text-base font-medium leading-tight text-foreground"
                }
            >
                {shortRecipient || tPay("selectRecipientPlaceholder")}
            </span>
        </span>
    );

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2">
                <FormField
                    control={control}
                    name={tokenName}
                    render={({ field: tokenField }) => (
                        <TokenSelect
                            disabled={tokenLocked}
                            locked={tokenLocked}
                            selectedToken={token}
                            setSelectedToken={(selected: SelectedTokenData) => {
                                tokenField.onChange(selected);
                            }}
                            showOnlyOwnedAssets={false}
                            autoSelect={tokenAutoSelect}
                            filterTokens={
                                isConfidential && !tokenLocked
                                    ? filterIntentsOnly
                                    : undefined
                            }
                            balanceLayout="usdPrimary"
                            appearance="card"
                            triggerLabel={tPay("tokenLabel")}
                        />
                    )}
                />

                {recipientLocked ? (
                    <div className={selectorTriggerClassName}>
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-general-border bg-muted">
                            <Icon
                                icon={Wallet03Icon}
                                className="size-5 text-muted-foreground"
                            />
                        </span>
                        {recipientRow}
                    </div>
                ) : (
                    <Button
                        type="button"
                        variant="unstyled"
                        onClick={() => setIsContactModalOpen(true)}
                        className={selectorTriggerClassName}
                    >
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-general-border bg-muted">
                            <Icon
                                icon={Wallet03Icon}
                                className="size-5 text-muted-foreground"
                            />
                        </span>
                        {recipientRow}
                        <Icon
                            icon={ArrowDown01Icon}
                            className="size-4 shrink-0 text-muted-foreground"
                        />
                    </Button>
                )}

                {destinationNetworkField}
            </div>

            <TokenInput
                control={control}
                amountName={amountName}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tokenName={tokenName as any}
                dynamicFontSize={true}
                onAmountInput={onAmountInput}
                onMaxSet={onMaxSet}
                variant="amountCard"
                enableUsdToggle
                usdValueOverride={usdValueOverride}
                balanceOverrideRaw={balanceOverrideRaw}
                balanceFromToken={balanceFromToken}
                warningMessage={sendWarningMessage}
                showInsufficientBalance={
                    !feeErrorMessage || showRestrictedRecipientAlert
                }
                networkFee={networkFee}
                errorMessage={
                    showRestrictedRecipientAlert ? null : feeErrorMessage
                }
            />

            {!recipientLocked ? (
                <div className="hidden" aria-hidden>
                    <AccountInput
                        key={`${recipient}-${blockchainType}`}
                        blockchain={blockchainType}
                        value={recipient}
                        setValue={(val) =>
                            setRecipientValue(
                                val as PathValue<
                                    TFieldValues,
                                    Path<TFieldValues>
                                >,
                            )
                        }
                        setIsValid={setIsRecipientValid}
                        setIsValidating={setIsValidatingRecipient}
                        borderless
                        validateOnMount={!!recipient}
                        requireNearComPrefix={requireNearComPrefix}
                    />
                </div>
            ) : null}

            {!recipientLocked ? (
                <RecipientSelectModal
                    isOpen={isContactModalOpen}
                    onClose={() => setIsContactModalOpen(false)}
                    contacts={addressBook}
                    chainMap={chainMap}
                    networkName={
                        destinationLocked || hideRecipientNetwork
                            ? isNearComNetwork(destinationNetworkId)
                                ? destinationNetworkId
                                : selectedNetworkName || null
                            : null
                    }
                    networkDisplayName={
                        destinationLocked || hideRecipientNetwork
                            ? networkDisplayName
                            : null
                    }
                    onSelect={({ address, contact }) => {
                        setSelectedContact(contact ?? null);
                        setRecipientValue(
                            address as PathValue<
                                TFieldValues,
                                Path<TFieldValues>
                            >,
                        );
                    }}
                    restrictedAlert={restrictedAlertNode}
                />
            ) : null}

            <CreateRequestButton
                onClick={onSave}
                disabled={isSaveDisabled}
                isSubmitting={isSubmitting}
                idleMessage={saveButtonText}
                className="w-full h-11 rounded-2xl"
                permissions={savePermissions}
            />
        </div>
    );
}

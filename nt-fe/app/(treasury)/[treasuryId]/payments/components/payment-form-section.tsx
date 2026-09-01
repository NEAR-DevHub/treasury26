"use client";

import {
    ArrowDown01Icon,
    Cancel01Icon,
    Contact01Icon,
    Wallet03Icon,
} from "@hugeicons/core-free-icons";
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
import { SelectModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import AccountInput from "@/components/account-input";
import { Button } from "@/components/button";
import {
    CreateRequestButton,
    type PermissionRequirement,
} from "@/components/create-request-button";
import { Icon } from "@/components/icon";
import { InfoAlert } from "@/components/info-alert";
import { InputBlock } from "@/components/input-block";
import { NetworkList } from "@/components/network-list";
import { selectorTriggerClassName } from "@/components/selector-field";
import { getNetworkDisplayName } from "@/components/token-display";
import { type Token, TokenInput } from "@/components/token-input";
import TokenSelect, { type SelectedTokenData } from "@/components/token-select";
import { FormField } from "@/components/ui/form";
import { User } from "@/components/user";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import {
    type AddressBookEntry,
    addressBookEntryMatchesNetwork,
    findAddressBookEntry,
    formatAddressBookDisplayAddress,
    useAddressBook,
} from "@/features/address-book";
import { type ChainInfo, useChains } from "@/features/address-book/chains";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { isNearComNetwork } from "@/lib/intents-network";
import { resolveRecipientBlockchain } from "@/lib/recipient-address-rules";
import type { SectionRule } from "@/lib/section-rules";
import { cn } from "@/lib/utils";
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
    /** Confidential Send: card selectors + recipient modal. */
    confidentialAggregated?: boolean;
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
    confidentialAggregated = false,
    balanceOverrideRaw = null,
    usdValueOverride = null,
}: PaymentFormSectionProps<TFieldValues, TTokenPath>) {
    const t = useTranslations("paymentFormSection");
    const tPay = useTranslations("payments");
    const tRecipientNetwork = useTranslations("recipientNetworkSelect");
    const { setValue, setError, clearErrors } = useFormContext<TFieldValues>();
    const [isRecipientValid, setIsRecipientValid] = useState(false);
    const [isValidatingRecipient, setIsValidatingRecipient] = useState(false);
    const [isContactModalOpen, setIsContactModalOpen] = useState(false);
    const [selectedContact, setSelectedContact] =
        useState<AddressBookEntry | null>(null);
    const { data: addressBook = [] } = useAddressBook();
    const { data: chains = [] } = useChains();

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
    const requireNearComPrefix =
        requireNearComPrefixProp || isNearComNetwork(destinationNetworkId);
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

    // For bulk (hideRecipientNetwork=true) validate against the receive
    // network (override or form field), falling back to NEAR. When the
    // network selector is shown, the recipient input runs in "unknown" mode
    // and compatibility is surfaced through the network selector sections.
    // Confidential: validate against the selected destination network.
    const blockchainType = useMemo(() => {
        if (confidentialAggregated && selectedNetworkName) {
            return resolveRecipientBlockchain(selectedNetworkName);
        }
        if (!hideRecipientNetwork) return "unknown";
        if (!selectedNetworkName) return NEAR_NETWORK_ID;
        return resolveRecipientBlockchain(selectedNetworkName);
    }, [confidentialAggregated, hideRecipientNetwork, selectedNetworkName]);

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
            selectedNetworkName,
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
        selectedNetworkName,
        selectedContact,
        setRecipientValue,
    ]);

    const filteredAddressBook = useMemo(
        () =>
            hideRecipientNetwork
                ? addressBook.filter((entry) =>
                      addressBookEntryMatchesNetwork(
                          entry,
                          selectedNetworkName,
                          blockchainType,
                      ),
                  )
                : addressBook,
        [
            addressBook,
            blockchainType,
            hideRecipientNetwork,
            selectedNetworkName,
        ],
    );

    // When recipient is pre-filled (e.g. stepping back from review), check if it matches an address book entry
    useEffect(() => {
        if (!recipient || selectedContact || filteredAddressBook.length === 0)
            return;
        const match = findAddressBookEntry(filteredAddressBook, recipient);
        if (match) setSelectedContact(match);
    }, [recipient, filteredAddressBook, selectedContact]);

    const showContactButton = filteredAddressBook.length > 0;

    const contactOptions = useMemo(
        () =>
            filteredAddressBook.map((entry) => ({
                id: entry.id,
                name: entry.name,
                symbol: entry.address,
                icon: "",
            })),
        [filteredAddressBook],
    );

    const networkDisplayName = selectedNetworkName
        ? getNetworkDisplayName(selectedNetworkName)
        : null;

    const isSaveDisabled =
        slotBlocked ||
        !hasValidAmount ||
        !recipient ||
        (hideRecipientNetwork && !recipientLocked && !isRecipientValid) ||
        (!hideRecipientNetwork && !hasSelectedNetwork) ||
        showRestrictedRecipientAlert ||
        isValidatingRecipient ||
        (!!feeErrorMessage && !showRestrictedRecipientAlert) ||
        isSubmitting;

    const handleClearContact = () => {
        setSelectedContact(null);
        setRecipientValue("" as PathValue<TFieldValues, Path<TFieldValues>>);
        setIsRecipientValid(false);
    };

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
                        appearance={confidentialAggregated ? "card" : "default"}
                        requireRecipient={!confidentialAggregated}
                        autoSelect={!destinationLocked}
                        locked={destinationLocked}
                        label={
                            confidentialAggregated
                                ? tRecipientNetwork("label")
                                : undefined
                        }
                        placeholder={
                            confidentialAggregated
                                ? tRecipientNetwork("placeholder")
                                : undefined
                        }
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

    if (confidentialAggregated) {
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
                                setSelectedToken={(
                                    selected: SelectedTokenData,
                                ) => {
                                    tokenField.onChange(selected);
                                }}
                                showOnlyOwnedAssets={false}
                                autoSelect={tokenAutoSelect}
                                filterTokens={(tok) =>
                                    (tok.residency || "").toLowerCase() ===
                                    "intents"
                                }
                                balanceLayout="usdPrimary"
                                appearance="card"
                                triggerLabel={tPay("tokenLabel")}
                            />
                        )}
                    />

                    {destinationNetworkField}

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
                        <span className="flex min-w-0 flex-1 flex-col items-start gap-px">
                            <span className="text-sm font-medium leading-normal text-muted-foreground">
                                {tPay("recipientLabel")}
                            </span>
                            {selectedContact || recipient ? (
                                <span className="max-w-full truncate text-base font-medium leading-tight text-foreground">
                                    {selectedContact ? (
                                        <User
                                            accountId={selectedContact.address}
                                            name={selectedContact.name}
                                            preferAddressBook
                                            size="sm"
                                            withLink={false}
                                        />
                                    ) : (
                                        recipient
                                    )}
                                </span>
                            ) : (
                                <span className="max-w-full truncate text-base font-medium leading-tight text-foreground">
                                    {tPay("selectRecipientPlaceholder")}
                                </span>
                            )}
                        </span>
                        <Icon
                            icon={ArrowDown01Icon}
                            className="size-4 shrink-0 text-muted-foreground"
                        />
                    </Button>
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
                    warningMessage={sendWarningMessage}
                    showInsufficientBalance={
                        !feeErrorMessage || showRestrictedRecipientAlert
                    }
                    networkFee={networkFee}
                    errorMessage={
                        showRestrictedRecipientAlert ? null : feeErrorMessage
                    }
                />

                {/* Keep AccountInput mounted for validation when address is set */}
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

                <RecipientSelectModal
                    isOpen={isContactModalOpen}
                    onClose={() => setIsContactModalOpen(false)}
                    contacts={addressBook}
                    chainMap={chainMap}
                    networkName={
                        isNearComNetwork(destinationNetworkId)
                            ? destinationNetworkId
                            : selectedNetworkName || null
                    }
                    networkDisplayName={networkDisplayName}
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

                <CreateRequestButton
                    onClick={onSave}
                    disabled={isSaveDisabled}
                    isSubmitting={isSubmitting}
                    idleMessage={saveButtonText}
                    className="w-full h-11 rounded-2xl"
                    permissions={{
                        kind: "transfer",
                        action: "AddProposal",
                    }}
                />
            </div>
        );
    }

    return (
        <>
            <TokenInput
                control={control}
                title={t("send")}
                amountName={amountName}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tokenName={tokenName as any}
                dynamicFontSize={true}
                onAmountInput={onAmountInput}
                onMaxSet={onMaxSet}
                tokenSelect={{
                    locked: tokenLocked,
                    disabled: tokenLocked,
                    showOnlyOwnedAssets: false,
                    autoSelect: tokenAutoSelect,
                }}
                warningMessage={sendWarningMessage}
                showInsufficientBalance={
                    !feeErrorMessage || showRestrictedRecipientAlert
                }
                networkFee={networkFee}
                balanceFromToken={balanceFromToken}
                errorMessage={
                    showRestrictedRecipientAlert ? null : feeErrorMessage
                }
            />

            <InputBlock
                interactive={!selectedContact && !recipientLocked}
                title={t("to")}
                className="relative"
                invalid={
                    hideRecipientNetwork &&
                    !recipientLocked &&
                    !selectedContact &&
                    !!recipient &&
                    !isRecipientValid &&
                    !isValidatingRecipient
                }
            >
                {recipientLocked ? (
                    <p className="text-muted-foreground truncate pt-1">
                        {recipient}
                    </p>
                ) : selectedContact ? (
                    <div className="flex items-center pt-1 pr-20">
                        <div className="flex flex-col gap-1 min-w-0">
                            <User
                                accountId={selectedContact.address}
                                displayAddress={formatAddressBookDisplayAddress(
                                    selectedContact,
                                )}
                                name={selectedContact.name}
                                size="md"
                                withLink={false}
                            />
                        </div>
                    </div>
                ) : (
                    <AccountInput
                        key={blockchainType}
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
                        validateOnMount={hideRecipientNetwork && !!recipient}
                        requireNearComPrefix={requireNearComPrefix}
                    />
                )}
                <div className="absolute top-1/2 -translate-y-1/2 right-3 flex items-center gap-1">
                    <Button
                        variant="secondary"
                        size="icon-sm"
                        onClick={handleClearContact}
                        type="button"
                        aria-hidden={!selectedContact}
                        tabIndex={selectedContact ? 0 : -1}
                        className={cn(
                            !selectedContact && "invisible pointer-events-none",
                        )}
                    >
                        <Icon icon={Cancel01Icon} />
                    </Button>
                    {showContactButton && !recipientLocked && (
                        <Button
                            variant="card"
                            size="icon-sm"
                            onClick={() => setIsContactModalOpen(true)}
                            type="button"
                        >
                            <Icon icon={Contact01Icon} />
                        </Button>
                    )}
                </div>
                {selectedContact && (
                    <div className="hidden" aria-hidden>
                        <AccountInput
                            key={`${recipient}-${blockchainType}`}
                            blockchain={blockchainType}
                            value={recipient}
                            setValue={() => {}}
                            setIsValid={setIsRecipientValid}
                            setIsValidating={setIsValidatingRecipient}
                            borderless
                            validateOnMount
                            requireNearComPrefix={requireNearComPrefix}
                        />
                    </div>
                )}
                {restrictedAlertNode ? (
                    <div className="px-1 pt-2">{restrictedAlertNode}</div>
                ) : null}
            </InputBlock>

            {destinationNetworkField}

            <SelectModal
                isOpen={isContactModalOpen}
                onClose={() => setIsContactModalOpen(false)}
                title={t("selectRecipient")}
                options={contactOptions}
                searchPlaceholder={t("searchByNameOrAddress")}
                onSelect={(option) => {
                    const entry = filteredAddressBook.find(
                        (e) => e.id === option.id,
                    );
                    if (entry) setSelectedContact(entry);
                    setIsContactModalOpen(false);
                }}
                renderIcon={() => null}
                renderContent={(option, { searchQuery }) => {
                    const entry = filteredAddressBook.find(
                        (e) => e.id === option.id,
                    );
                    if (!entry) return null;
                    const entryChains = entry.networks
                        .map((key) => chainMap.get(key))
                        .filter(Boolean) as ChainInfo[];
                    return (
                        <div className="flex items-center justify-between w-full gap-2">
                            <User
                                accountId={entry.address}
                                displayAddress={formatAddressBookDisplayAddress(
                                    entry,
                                )}
                                name={entry.name}
                                size="sm"
                                withLink={false}
                                highlightQuery={searchQuery}
                            />
                            {entryChains.length > 0 && (
                                <NetworkList
                                    chains={entryChains}
                                    className="shrink-0"
                                    badgeVariant="secondary"
                                    badgeSize="icon"
                                    maxVisible={2}
                                    badgeIconOnly
                                />
                            )}
                        </div>
                    );
                }}
            />

            <CreateRequestButton
                onClick={onSave}
                disabled={isSaveDisabled}
                isSubmitting={isSubmitting}
                idleMessage={saveButtonText}
                permissions={savePermissions}
            />
        </>
    );
}

"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import Gleap from "gleap";
import {
    Control,
    FieldValues,
    Path,
    PathValue,
    useFormContext,
    useWatch,
} from "react-hook-form";
import { ContactRound, X } from "lucide-react";
import { InputBlock } from "@/components/input-block";
import { TokenInput, Token } from "@/components/token-input";
import AccountInput from "@/components/account-input";
import { CreateRequestButton } from "@/components/create-request-button";
import { InfoAlert } from "@/components/info-alert";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { useAddressBook, AddressBookEntry } from "@/features/address-book";
import { SelectModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { useChains, ChainInfo } from "@/features/address-book/chains";
import { NetworkList } from "@/components/network-list";
import { Button } from "@/components/button";
import { UserWithData } from "@/components/user";
import { FormField } from "@/components/ui/form";
import { type SectionRule } from "@/lib/section-rules";
import {
    RecipientNetworkSelect,
    type RecipientNetworkRuleOption,
} from "./recipient-network-select";
import { cn } from "@/lib/utils";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";

interface PaymentFormSectionProps<
    TFieldValues extends FieldValues = FieldValues,
    TTokenPath extends Path<TFieldValues> = Path<TFieldValues>,
> {
    control: Control<TFieldValues>;
    amountName: Path<TFieldValues>;
    tokenName: TTokenPath extends Path<TFieldValues>
        ? PathValue<TFieldValues, TTokenPath> extends Token
            ? TTokenPath
            : never
        : never;
    recipientName: Path<TFieldValues>;

    tokenLocked?: boolean;
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
    bridgeAssets?: BridgeAsset[];
    isBridgeAssetsLoading?: boolean;
    sendWarningMessage?: string | null;
    recipientNetworkWarningMessage?: string | null;
    /** True when payments are blocked by a critical warning (not warning/info). */
    slotBlocked?: boolean;
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
    bridgeAssets = [],
    isBridgeAssetsLoading = false,
    sendWarningMessage,
    recipientNetworkWarningMessage,
    slotBlocked = false,
}: PaymentFormSectionProps<TFieldValues, TTokenPath>) {
    const t = useTranslations("paymentFormSection");
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
            ...(destinationNetworkNameFieldName
                ? [destinationNetworkNameFieldName]
                : []),
        ] as Path<TFieldValues>[],
    }) as unknown as [Token | null, string, string | undefined];
    const token = watched[0];
    const recipient = (watched[1] ?? "") as string;
    const selectedNetworkName = (watched[2] ?? "") as string;
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

    // For bulk (hideRecipientNetwork=true) we still validate against token's
    // chain. When the network selector is shown, the recipient input runs in
    // "unknown" mode (no validation) and compatibility is surfaced through
    // the network selector sections instead.
    const blockchainType = useMemo(() => {
        if (!hideRecipientNetwork) return "unknown";
        if (!selectedNetworkName) return NEAR_NETWORK_ID;
        return getBlockchainType(selectedNetworkName);
    }, [hideRecipientNetwork, selectedNetworkName]);

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
                selectedContact.address as PathValue<
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
        const isCompatible =
            selectedContact.networks.length === 0 ||
            selectedContact.networks.some(
                (key) => getBlockchainType(key) === blockchainType,
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
        selectedContact,
        setRecipientValue,
    ]);

    const filteredAddressBook = useMemo(
        () =>
            hideRecipientNetwork
                ? addressBook.filter(
                      (entry) =>
                          entry.networks.length === 0 ||
                          entry.networks.some(
                              (key) =>
                                  getBlockchainType(key) === blockchainType,
                          ),
                  )
                : addressBook,
        [addressBook, blockchainType, hideRecipientNetwork],
    );

    // When recipient is pre-filled (e.g. stepping back from review), check if it matches an address book entry
    useEffect(() => {
        if (!recipient || selectedContact || filteredAddressBook.length === 0)
            return;
        const match = filteredAddressBook.find(
            (e) => e.address.toLowerCase() === recipient.toLowerCase(),
        );
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

    const isSaveDisabled =
        slotBlocked ||
        !hasValidAmount ||
        !recipient ||
        (hideRecipientNetwork && !isRecipientValid) ||
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
                }}
                warningMessage={sendWarningMessage}
                showInsufficientBalance={
                    !feeErrorMessage || showRestrictedRecipientAlert
                }
                networkFee={networkFee}
            />

            <InputBlock
                interactive={!selectedContact}
                title={t("to")}
                className="relative"
                invalid={
                    hideRecipientNetwork &&
                    !selectedContact &&
                    !!recipient &&
                    !isRecipientValid &&
                    !isValidatingRecipient
                }
            >
                {selectedContact ? (
                    <div className="flex items-center pt-1 pr-20">
                        <div className="flex flex-col gap-1 min-w-0">
                            <UserWithData
                                name={selectedContact.name}
                                address={selectedContact.address}
                                useAddressBook
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
                        <X className="size-3.5" />
                    </Button>
                    {showContactButton && (
                        <Button
                            variant="card"
                            size="icon-sm"
                            onClick={() => setIsContactModalOpen(true)}
                            type="button"
                        >
                            <ContactRound className="size-4" />
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
                        />
                    </div>
                )}
            </InputBlock>

            {!hideRecipientNetwork && destinationNetworkName && (
                <FormField
                    control={control}
                    name={destinationNetworkName}
                    render={({ field }) => (
                        <RecipientNetworkSelect
                            value={(field.value as string | undefined) ?? ""}
                            recipient={recipient}
                            sectionRules={networkSectionRules}
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
            )}

            {showRestrictedRecipientAlert && (
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
            )}

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
                renderContent={(option) => {
                    const entry = filteredAddressBook.find(
                        (e) => e.id === option.id,
                    );
                    if (!entry) return null;
                    const entryChains = entry.networks
                        .map((key) => chainMap.get(key))
                        .filter(Boolean) as ChainInfo[];
                    return (
                        <div className="flex items-center justify-between w-full gap-2">
                            <UserWithData
                                name={entry.name}
                                address={entry.address}
                                useAddressBook
                                size="sm"
                                withLink={false}
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
                permissions={{
                    kind: "transfer",
                    action: "AddProposal",
                }}
            />
        </>
    );
}

"use client";

import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    IdCardIcon,
    ScanIcon,
    Wallet03Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/modal";
import { Button } from "@/components/button";
import { NetworkList } from "@/components/network-list";
import { PaymentSelectModalContent } from "@/components/payment-select-modal-content";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { isValidAddress } from "@/lib/address-validation";
import {
    isValidNearAddressFormat,
    validateNearAddress,
} from "@/lib/near-validation";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import type { AddressBookEntry } from "@/features/address-book";
import {
    formatAddressBookDisplayAddress,
    isNearComAddressBookEntry,
} from "@/features/address-book";
import type { ChainInfo } from "@/features/address-book/chains";
import { isNearComNetwork } from "@/lib/intents-network";
import {
    isNearComRecipientAddress,
    stripNearComAddressPrefix,
} from "@/lib/nearcom-address";
import { paymentSelectModalListClassName } from "@/components/selector-field";
import { cn } from "@/lib/utils";
import { RecipientQrScanner } from "./recipient-qr-scanner";

function shortAddress(address: string, prefix = 6, suffix = 6): string {
    if (address.length <= prefix + suffix) return address;
    return `${address.slice(0, prefix)}...${address.slice(-suffix)}`;
}

function ContactAvatar() {
    return (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-general-indigo-border bg-general-indigo-background-faded">
            <Icon
                icon={Wallet03Icon}
                className="size-5 text-general-indigo-foreground"
            />
        </span>
    );
}

interface RecipientSelectModalProps {
    isOpen: boolean;
    onClose: () => void;
    contacts: AddressBookEntry[];
    chainMap: Map<string, ChainInfo>;
    /** Raw destination network name (e.g. "solana") for filtering + empty copy. */
    networkName?: string | null;
    networkDisplayName?: string | null;
    onSelect: (value: {
        address: string;
        contact?: AddressBookEntry | null;
    }) => void;
    restrictedAlert?: React.ReactNode;
}

export function RecipientSelectModal({
    isOpen,
    onClose,
    contacts,
    chainMap,
    networkName,
    networkDisplayName,
    onSelect,
    restrictedAlert,
}: RecipientSelectModalProps) {
    const t = useTranslations("paymentFormSection");
    const [draft, setDraft] = useState("");
    const [view, setView] = useState<"list" | "scan">("list");
    const [isValidating, setIsValidating] = useState(false);
    const [isValid, setIsValid] = useState(false);
    const [showInvalid, setShowInvalid] = useState(false);
    const validationSeq = useRef(0);

    const blockchain = useMemo(() => {
        if (!networkName) return "unknown" as const;
        return getBlockchainType(networkName);
    }, [networkName]);

    useEffect(() => {
        if (!isOpen) {
            setDraft("");
            setView("list");
            setIsValid(false);
            setShowInvalid(false);
            setIsValidating(false);
            validationSeq.current += 1;
        }
    }, [isOpen]);

    const validateDraft = useCallback(
        async (value: string) => {
            const seq = ++validationSeq.current;
            const trimmed = value.trim();
            if (!trimmed) {
                setIsValid(false);
                setShowInvalid(false);
                setIsValidating(false);
                return;
            }

            // No destination network yet — don't claim the string is a valid
            // chain address (length>=2 was incorrectly accepting contact names).
            if (blockchain === "unknown") {
                setIsValid(false);
                setShowInvalid(false);
                setIsValidating(false);
                return;
            }

            if (isNearComNetwork(networkName)) {
                if (!isNearComRecipientAddress(trimmed)) {
                    if (seq !== validationSeq.current) return;
                    setIsValid(false);
                    setShowInvalid(true);
                    setIsValidating(false);
                    return;
                }
            }

            if (blockchain === NEAR_NETWORK_ID) {
                const accountId = stripNearComAddressPrefix(trimmed);
                if (!isValidNearAddressFormat(accountId)) {
                    if (seq !== validationSeq.current) return;
                    setIsValid(false);
                    setShowInvalid(true);
                    setIsValidating(false);
                    return;
                }
                setIsValidating(true);
                const result = await validateNearAddress(accountId);
                if (seq !== validationSeq.current) return;
                const ok = result === null;
                setIsValidating(false);
                setIsValid(ok);
                setShowInvalid(!ok);
                return;
            }

            const ok = isValidAddress(trimmed, blockchain);
            if (seq !== validationSeq.current) return;
            setIsValid(ok);
            setShowInvalid(!ok);
            setIsValidating(false);
        },
        [blockchain, networkName],
    );

    useEffect(() => {
        const handle = window.setTimeout(() => {
            void validateDraft(draft);
        }, 250);
        return () => window.clearTimeout(handle);
    }, [draft, validateDraft]);

    const filteredContacts = useMemo(() => {
        if (!networkName) return contacts;
        if (isNearComNetwork(networkName)) {
            return contacts.filter(isNearComAddressBookEntry);
        }
        const networkChain = getBlockchainType(networkName);
        return contacts.filter(
            (entry) =>
                entry.networks.length === 0 ||
                entry.networks.some(
                    (key) =>
                        !isNearComNetwork(key) &&
                        getBlockchainType(key) === networkChain,
                ),
        );
    }, [contacts, networkName]);

    const query = draft.trim().toLowerCase();
    const searchedContacts = useMemo(() => {
        if (!query) return filteredContacts;
        return filteredContacts.filter(
            (entry) =>
                entry.name.toLowerCase().includes(query) ||
                entry.address.toLowerCase().includes(query),
        );
    }, [filteredContacts, query]);

    const hasMatchingContacts = searchedContacts.length > 0;
    // Address errors only when the query isn't matching contacts (name search).
    const showInvalidError =
        !!draft.trim() &&
        showInvalid &&
        !isValidating &&
        !hasMatchingContacts &&
        blockchain !== "unknown";

    const showTypedAddressRow =
        !!draft.trim() &&
        isValid &&
        !isValidating &&
        !showInvalid &&
        blockchain !== "unknown";

    const handlePickAddress = (address: string, contact?: AddressBookEntry) => {
        onSelect({ address, contact: contact ?? null });
        onClose();
    };

    const handleQrDetected = useCallback((address: string) => {
        setDraft(address.replace(/\s/g, ""));
        setView("list");
    }, []);

    const isScanView = view === "scan";

    return (
        <Dialog
            open={isOpen}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <PaymentSelectModalContent>
                <DialogHeader
                    centerTitle={false}
                    className="sticky top-0 border-0 pb-0 text-left"
                >
                    <DialogTitle className="pr-8 text-left text-lg font-semibold">
                        {isScanView ? t("qrScanTitle") : t("selectRecipient")}
                    </DialogTitle>
                </DialogHeader>

                {isScanView ? (
                    <RecipientQrScanner
                        onDetected={handleQrDetected}
                        onBack={() => setView("list")}
                    />
                ) : (
                    <div className="mt-4 flex min-h-0 flex-1 flex-col space-y-4 sm:mt-0">
                        <div className="flex h-11 w-full shrink-0 items-center gap-2.5 rounded-xl border border-general-border bg-general-bg-tertiary px-3">
                            <Icon
                                icon={Wallet03Icon}
                                className="size-5 shrink-0 text-muted-foreground"
                            />
                            <input
                                value={draft}
                                onChange={(e) =>
                                    setDraft(e.target.value.replace(/\s/g, ""))
                                }
                                placeholder={t("searchByNameOrAddress")}
                                autoFocus
                                autoComplete="off"
                                autoCorrect="off"
                                className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm font-medium leading-normal text-muted-foreground outline-none placeholder:text-muted-foreground"
                                onKeyDown={(e) => {
                                    if (
                                        e.key === "Enter" &&
                                        showTypedAddressRow
                                    ) {
                                        e.preventDefault();
                                        handlePickAddress(draft.trim());
                                    }
                                }}
                            />
                            {draft ? (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="shrink-0"
                                    onClick={() => setDraft("")}
                                >
                                    <Icon icon={Cancel01Icon} />
                                </Button>
                            ) : null}
                        </div>

                        {!hasMatchingContacts &&
                        !showTypedAddressRow &&
                        !showInvalidError ? (
                            <p className="px-1 text-left text-sm font-medium leading-normal text-general-secondary-foreground">
                                {networkDisplayName || networkName
                                    ? t("noContactsForNetwork", {
                                          network: (
                                              networkDisplayName ||
                                              networkName ||
                                              ""
                                          ).toLowerCase(),
                                      })
                                    : t("noContacts")}
                            </p>
                        ) : null}

                        <button
                            type="button"
                            className="flex w-full items-center gap-3 rounded-xl px-1 py-1 text-left hover:bg-muted lg:hidden"
                            onClick={() => setView("scan")}
                        >
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                                <Icon
                                    icon={ScanIcon}
                                    className="size-5 text-foreground"
                                />
                            </span>
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-base font-semibold leading-tight text-foreground">
                                    {t("scanQrCode")}
                                </span>
                                <span className="text-sm font-medium leading-normal text-general-secondary-foreground">
                                    {t("scanQrCodeDescription")}
                                </span>
                            </span>
                        </button>

                        {restrictedAlert}

                        <div
                            className={cn(
                                "flex flex-col gap-2 overflow-y-auto",
                                paymentSelectModalListClassName,
                            )}
                        >
                            {showInvalidError ? (
                                <p className="px-1 text-left text-sm text-destructive">
                                    {t("invalidAddress")}
                                </p>
                            ) : null}

                            {showTypedAddressRow ? (
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-muted"
                                    onClick={() =>
                                        handlePickAddress(draft.trim())
                                    }
                                >
                                    <ContactAvatar />
                                    <span className="truncate text-base font-semibold leading-tight text-foreground">
                                        {shortAddress(draft.trim())}
                                    </span>
                                </button>
                            ) : null}

                            {hasMatchingContacts ? (
                                <>
                                    <div className="flex items-center gap-2 px-1 text-sm font-medium leading-normal text-general-secondary-foreground">
                                        <Icon
                                            icon={IdCardIcon}
                                            className="size-4"
                                        />
                                        <span>{t("contacts")}</span>
                                    </div>
                                    <div className="flex flex-col">
                                        {searchedContacts.map((entry) => {
                                            const entryChains = entry.networks
                                                .map((key) => chainMap.get(key))
                                                .filter(Boolean) as ChainInfo[];
                                            return (
                                                <button
                                                    key={entry.id}
                                                    type="button"
                                                    className="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2.5 text-left hover:bg-muted"
                                                    onClick={() =>
                                                        handlePickAddress(
                                                            formatAddressBookDisplayAddress(
                                                                entry,
                                                            ),
                                                            entry,
                                                        )
                                                    }
                                                >
                                                    <div className="flex min-w-0 items-center gap-3">
                                                        <ContactAvatar />
                                                        <div className="flex min-w-0 flex-col gap-0.5">
                                                            <span className="truncate text-base font-semibold leading-tight text-foreground">
                                                                {entry.name}
                                                            </span>
                                                            <span className="truncate text-sm font-medium leading-normal text-general-secondary-foreground">
                                                                {shortAddress(
                                                                    entry.address,
                                                                )}
                                                            </span>
                                                        </div>
                                                    </div>
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
                                                </button>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </div>
                )}
            </PaymentSelectModalContent>
        </Dialog>
    );
}

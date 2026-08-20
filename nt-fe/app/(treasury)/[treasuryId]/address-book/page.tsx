"use client";

import { Icon } from "@/components/icon";
import {
    Add01Icon,
    Delete02Icon,
    FileDownloadIcon,
    FileUploadIcon,
    Loading02Icon,
} from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { AuthButton } from "@/components/auth-button";
import { EmptyState } from "@/components/empty-state";
import {
    AddRecipientInput,
    buildFormSchema,
    type FormValues,
} from "@/features/address-book/components/add-recipient-form";
import { RECIPIENT_NAME_MAX_LENGTH } from "@/features/address-book/types";
import { Form } from "@/components/ui/form";
import { ReviewRecipients } from "@/features/address-book/components/review-recipients";
import { AddressBookTable } from "@/features/address-book/components/address-book-table";
import { RemoveRecipientDialog } from "@/features/address-book/components/remove-recipient-dialog";
import {
    ImportUploadStep,
    type ParsedRecipient,
} from "@/features/address-book/components/import-recipients-flow";
import {
    useCreateAddressBookEntries,
    useAddressBook,
    useDeleteAddressBookEntries,
    useExportAddressBook,
    type RecipientDraft,
    type AddressBookEntry,
} from "@/features/address-book";
import { useChains } from "@/features/address-book/chains";
import { useTreasury } from "@/hooks/use-treasury";
import { TableSkeleton } from "@/components/table-skeleton";
import { ResponsiveInput } from "@/components/input";
import { NumberBadge } from "@/components/number-badge";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
    buildNetworkLookup,
    resolveNetworkName,
} from "@/features/address-book/utils/resolve-network";
import { buildPaymentsDeepLink } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-transfer-url";
import { StepperHeader } from "@/components/step-wizard";

// ─── Empty state ──────────────────────────────────────────────────────────────

function AddressBookEmptyState({
    onAdd,
    onImport,
}: {
    onAdd: () => void;
    onImport: () => void;
}) {
    const tAb = useTranslations("addressBook");
    return (
        <PageCard className="py-[100px] flex flex-col items-center justify-center w-full h-fit gap-4">
            <EmptyState
                icon={FileUploadIcon}
                title={tAb("emptyTitle")}
                description={tAb("emptyDescription")}
                className="py-0"
            />
            <div className="flex gap-3 w-full max-w-[300px]">
                <AuthButton
                    permissionKind="any"
                    permissionAction=""
                    variant="secondary"
                    className="gap-1 shrink w-full"
                    onClick={onImport}
                >
                    <Icon icon={FileUploadIcon} /> {tAb("import")}
                </AuthButton>
                <AuthButton
                    permissionKind="any"
                    permissionAction=""
                    className="gap-1 shrink w-full"
                    onClick={onAdd}
                >
                    <Icon icon={Add01Icon} /> {tAb("addRecipient")}
                </AuthButton>
            </div>
        </PageCard>
    );
}

// ─── Add / Import flow (shared stepper) ──────────────────────────────────────

function RecipientFlow({
    mode,
    initialRecipient,
    existingEntries = [],
    onDone,
    onCancel,
    onImport,
}: {
    mode: "add" | "import";
    initialRecipient?: RecipientDraft | null;
    existingEntries?: AddressBookEntry[];
    onDone: () => void;
    onCancel: () => void;
    onImport: () => void;
}) {
    const { treasuryId } = useTreasury();
    const tValidation = useTranslations("recipientForm.validation");
    const [step, setStep] = useState(0);
    const [activeIndex, setActiveIndex] = useState(0);
    const [importNotes, setImportNotes] = useState<Record<number, string>>({});
    const createEntries = useCreateAddressBookEntries(treasuryId);
    const defaultValues = useMemo(
        () => ({
            recipients: [
                initialRecipient ?? { name: "", networks: [], address: "" },
            ],
        }),
        [initialRecipient],
    );

    const formSchema = useMemo(
        () =>
            buildFormSchema({
                nameRequired: tValidation("nameRequired"),
                nameMax: tValidation("nameMax", {
                    max: RECIPIENT_NAME_MAX_LENGTH,
                }),
                addressRequired: tValidation("addressRequired"),
                networksRequired: tValidation("networksRequired"),
            }),
        [tValidation],
    );

    const form = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues,
        mode: "onChange",
    });

    useEffect(() => {
        form.reset(defaultValues);
        setStep(0);
        setActiveIndex(0);
        setImportNotes({});
    }, [defaultValues, form]);

    // Manual add: filter empty rows → review
    const handleManualReview = () => {
        const filled = form
            .getValues()
            .recipients.filter((r) => r.name.trim() || r.address.trim());
        form.reset({ recipients: filled });
        setStep(1);
    };

    // Import: parsed recipients → populate form → review
    const handleImportReview = (parsed: ParsedRecipient[]) => {
        const notes: Record<number, string> = {};
        parsed.forEach((r, i) => {
            if (r.note) notes[i] = r.note;
        });
        setImportNotes(notes);
        form.reset({
            recipients: parsed.map((r) => ({
                name: r.name,
                address: r.address,
                networks: r.networks,
            })),
        });
        setStep(1);
    };

    const recipients = form.watch("recipients");

    return (
        <PageCard className="w-full max-w-[600px] mx-auto flex flex-col gap-4 p-4">
            <Form {...form}>
                {step === 0 ? (
                    mode === "add" ? (
                        <AddRecipientInput
                            control={form.control}
                            activeIndex={activeIndex}
                            setActiveIndex={setActiveIndex}
                            handleBack={onCancel}
                            onReview={handleManualReview}
                            onImport={onImport}
                        />
                    ) : (
                        <ImportUploadStep
                            handleBack={onCancel}
                            onReview={handleImportReview}
                        />
                    )
                ) : (
                    <ReviewRecipients
                        handleBack={() => setStep(0)}
                        control={form.control}
                        existingEntries={existingEntries}
                        isSubmitting={createEntries.isPending}
                        initialNotes={
                            mode === "import" ? importNotes : undefined
                        }
                        onSubmit={async (notes, includedIndexes) => {
                            if (!treasuryId) return;
                            await createEntries.mutateAsync({
                                daoId: treasuryId,
                                entries: includedIndexes.map((index) => {
                                    const recipient = recipients[index];

                                    return {
                                        name: recipient.name,
                                        networks: recipient.networks,
                                        address: recipient.address,
                                        note: notes[index] || undefined,
                                    };
                                }),
                            });
                            onDone();
                        }}
                    />
                )}
            </Form>
        </PageCard>
    );
}

// ─── Recipients table view ────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300;
const ADDRESS_BOOK_PAGE_SIZE = 20;

function RecipientsView({
    onAdd,
    onImport,
}: {
    onAdd: () => void;
    onImport: () => void;
}) {
    const tAb = useTranslations("addressBook");
    const tCommon = useTranslations("common");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { data: entries = [], isLoading } = useAddressBook();
    const deleteEntries = useDeleteAddressBookEntries(treasuryId);
    const exportEntries = useExportAddressBook(treasuryId);
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [mobileSearchActive, setMobileSearchActive] = useState(false);
    const [entryToDelete, setEntryToDelete] = useState<AddressBookEntry | null>(
        null,
    );
    const [bulkDeleteCount, setBulkDeleteCount] = useState(0);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isMobile = useMediaQuery("(max-width: 640px)");
    const page = Math.max(
        0,
        Number.parseInt(searchParams.get("page") || "0", 10) || 0,
    );

    const handleSearchChange = useCallback((value: string) => {
        setSearch(value);
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => {
            setDebouncedSearch(value.trim());
        }, SEARCH_DEBOUNCE_MS);
    }, []);

    const updatePage = useCallback(
        (newPage: number, replace = false) => {
            const params = new URLSearchParams(searchParams.toString());

            if (newPage === 0) {
                params.delete("page");
            } else {
                params.set("page", newPage.toString());
            }

            const nextUrl = params.toString()
                ? `${pathname}?${params.toString()}`
                : pathname;

            if (replace) {
                router.replace(nextUrl, { scroll: false });
                return;
            }

            router.push(nextUrl, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    useEffect(() => {
        return () => {
            if (searchTimeoutRef.current)
                clearTimeout(searchTimeoutRef.current);
        };
    }, []);

    const filtered = debouncedSearch
        ? entries.filter(
              (e) =>
                  e.name
                      .toLowerCase()
                      .includes(debouncedSearch.toLowerCase()) ||
                  e.address
                      .toLowerCase()
                      .includes(debouncedSearch.toLowerCase()),
          )
        : entries;
    const totalPages = Math.ceil(filtered.length / ADDRESS_BOOK_PAGE_SIZE);
    const pageIndex =
        totalPages === 0 ? 0 : Math.min(page, Math.max(totalPages - 1, 0));
    const paginatedEntries = filtered.slice(
        pageIndex * ADDRESS_BOOK_PAGE_SIZE,
        (pageIndex + 1) * ADDRESS_BOOK_PAGE_SIZE,
    );

    useEffect(() => {
        if (page !== pageIndex) {
            updatePage(pageIndex, true);
        }
    }, [page, pageIndex, updatePage]);

    const hasSelection = selectedIds.size > 0;

    function handleDelete(entry: AddressBookEntry) {
        setEntryToDelete(entry);
    }

    function handleRemoveSelected() {
        setBulkDeleteCount(selectedIds.size);
    }

    async function handleConfirmDelete() {
        if (bulkDeleteCount > 0) {
            await deleteEntries.mutateAsync([...selectedIds]);
            setSelectedIds(new Set());
            setBulkDeleteCount(0);
        } else if (entryToDelete) {
            await deleteEntries.mutateAsync([entryToDelete.id]);
            setSelectedIds((prev) => {
                const next = new Set(prev);
                next.delete(entryToDelete.id);
                return next;
            });
            setEntryToDelete(null);
        }
    }

    function handleCloseDialog() {
        setEntryToDelete(null);
        setBulkDeleteCount(0);
    }

    async function handleExport() {
        await exportEntries.mutateAsync(
            hasSelection ? [...selectedIds] : undefined,
        );
    }

    function handleSend(entry: AddressBookEntry) {
        if (!treasuryId) return;
        router.push(
            buildPaymentsDeepLink(treasuryId, {
                address: entry.address,
                name: entry.name,
                networks: entry.networks,
            }),
        );
    }

    return (
        <PageCard className="p-0 gap-0">
            {/* Header */}
            <div className="flex flex-row items-center justify-between gap-3 sm:gap-4 py-3.5 px-8 border-b">
                {hasSelection ? (
                    <>
                        <span className="font-semibold text-base">
                            {tAb("recipientsSelected", {
                                count: selectedIds.size,
                            })}
                        </span>
                        <div className="flex items-center gap-2">
                            <AuthButton
                                permissionKind="any"
                                permissionAction=""
                                variant="secondary"
                                size={isMobile ? "icon" : "default"}
                                disabled={exportEntries.isPending}
                                onClick={handleExport}
                            >
                                {exportEntries.isPending ? (
                                    <Icon
                                        icon={Loading02Icon}
                                        className="animate-spin"
                                    />
                                ) : (
                                    <Icon icon={FileDownloadIcon} />
                                )}
                                <span className="hidden sm:inline">
                                    {exportEntries.isPending
                                        ? tCommon("exporting")
                                        : tCommon("export")}
                                </span>
                            </AuthButton>
                            <AuthButton
                                permissionKind="any"
                                permissionAction=""
                                variant="outline-destructive"
                                size={isMobile ? "icon" : "default"}
                                disabled={deleteEntries.isPending}
                                onClick={() => handleRemoveSelected()}
                            >
                                <Icon icon={Delete02Icon} />
                                <span className="hidden sm:flex">
                                    {tCommon("remove")}
                                </span>
                            </AuthButton>
                        </div>
                    </>
                ) : (
                    <div className="flex items-center justify-between w-full gap-3">
                        <div className="flex flex-col gap-0 w-full max-w-md">
                            <div className="flex items-center gap-3 w-fit lg:pt-1">
                                <StepperHeader
                                    title={tAb("recipientsHeading")}
                                />
                                {entries.length > 0 && (
                                    <NumberBadge
                                        number={entries.length}
                                        variant="secondary"
                                    />
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground hidden min-w-0 lg:block">
                                {tAb("privacyNote")}
                            </p>
                        </div>
                        <div className="flex items-center gap-2 justify-end min-w-0 w-fit shrink-0">
                            <ResponsiveInput
                                type="text"
                                placeholder={tAb("searchPlaceholder")}
                                mobilePlaceholder={tAb(
                                    "searchPlaceholderShort",
                                )}
                                className="w-52 min-w-0"
                                search
                                value={search}
                                onChange={(e) =>
                                    handleSearchChange(e.target.value)
                                }
                                onSearchActiveChange={setMobileSearchActive}
                            />
                            <AuthButton
                                permissionKind="any"
                                permissionAction=""
                                variant="secondary"
                                className={cn(
                                    "gap-1.5",
                                    mobileSearchActive && "hidden sm:flex",
                                )}
                                size={isMobile ? "icon" : "default"}
                                disabled={exportEntries.isPending}
                                onClick={handleExport}
                            >
                                {exportEntries.isPending ? (
                                    <Icon
                                        icon={Loading02Icon}
                                        className="animate-spin"
                                    />
                                ) : (
                                    <Icon icon={FileDownloadIcon} />
                                )}
                                <span className="hidden sm:inline">
                                    {exportEntries.isPending
                                        ? tCommon("exporting")
                                        : tCommon("export")}
                                </span>
                            </AuthButton>
                            <AuthButton
                                permissionKind="any"
                                permissionAction=""
                                variant="secondary"
                                className={cn(
                                    "gap-1.5",
                                    mobileSearchActive && "hidden sm:flex",
                                )}
                                size={isMobile ? "icon" : "default"}
                                onClick={onImport}
                            >
                                <Icon icon={FileUploadIcon} />
                                <span className="hidden sm:inline">
                                    {tAb("import")}
                                </span>
                            </AuthButton>
                            <AuthButton
                                permissionKind="any"
                                permissionAction=""
                                className={cn(
                                    "gap-1.5",
                                    mobileSearchActive && "hidden sm:flex",
                                )}
                                size={isMobile ? "icon" : "default"}
                                onClick={onAdd}
                            >
                                <Icon icon={Add01Icon} />
                                <span className="hidden sm:inline">
                                    {tAb("addRecipient")}
                                </span>
                            </AuthButton>
                        </div>
                    </div>
                )}
            </div>

            {/* Table */}
            {isLoading ? (
                <TableSkeleton rows={6} columns={7} />
            ) : (
                <AddressBookTable
                    entries={paginatedEntries}
                    selectedIds={selectedIds}
                    onSelectionChange={setSelectedIds}
                    onDelete={handleDelete}
                    onSend={handleSend}
                    searchQuery={debouncedSearch}
                    pageIndex={pageIndex}
                    pageSize={ADDRESS_BOOK_PAGE_SIZE}
                    total={filtered.length}
                    onPageChange={updatePage}
                />
            )}

            <RemoveRecipientDialog
                entry={entryToDelete}
                count={bulkDeleteCount}
                onConfirm={handleConfirmDelete}
                onClose={handleCloseDialog}
            />
        </PageCard>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AddressBookPage() {
    const t = useTranslations("pages.addressBook");
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { data: entries, isLoading } = useAddressBook();
    const { data: chains = [], isLoading: isChainsLoading } = useChains();
    const [flowMode, setFlowMode] = useState<"add" | "import" | null>(null);
    const [initialRecipient, setInitialRecipient] =
        useState<RecipientDraft | null>(null);

    const hasEntries = (entries?.length ?? 0) > 0;
    const prefilledRecipient = useMemo(() => {
        const address = searchParams.get("address")?.trim();
        if (!address) return null;

        const rawNetworks = (
            searchParams.get("networks") ??
            searchParams.get("network") ??
            ""
        )
            .split(",")
            .map((network) => network.trim())
            .filter(Boolean);

        if (rawNetworks.length > 0 && isChainsLoading && chains.length === 0) {
            return null;
        }

        const networkLookup = buildNetworkLookup(chains);
        const networks = rawNetworks
            .map((network) => resolveNetworkName(network, networkLookup))
            .filter((network): network is string => Boolean(network));

        return {
            name: searchParams.get("name")?.trim() || address,
            address,
            networks,
        };
    }, [chains, isChainsLoading, searchParams]);

    const clearPrefillParams = useCallback(() => {
        const nextParams = new URLSearchParams(searchParams.toString());
        for (const key of ["name", "address", "network", "networks"]) {
            nextParams.delete(key);
        }

        const nextQuery = nextParams.toString();
        router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
            scroll: false,
        });
    }, [pathname, router, searchParams]);

    useEffect(() => {
        if (!prefilledRecipient) return;

        setInitialRecipient(prefilledRecipient);
        setFlowMode("add");
    }, [prefilledRecipient]);

    const handleAdd = useCallback(() => {
        setInitialRecipient(null);
        setFlowMode("add");
        clearPrefillParams();
    }, [clearPrefillParams]);

    const handleImport = useCallback(() => {
        setInitialRecipient(null);
        setFlowMode("import");
        clearPrefillParams();
    }, [clearPrefillParams]);

    const handleCloseFlow = useCallback(() => {
        setFlowMode(null);
        setInitialRecipient(null);
        clearPrefillParams();
    }, [clearPrefillParams]);

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            {flowMode ? (
                <RecipientFlow
                    mode={flowMode}
                    initialRecipient={initialRecipient}
                    existingEntries={entries ?? []}
                    onDone={handleCloseFlow}
                    onCancel={handleCloseFlow}
                    onImport={handleImport}
                />
            ) : isLoading || hasEntries ? (
                <RecipientsView onAdd={handleAdd} onImport={handleImport} />
            ) : (
                <AddressBookEmptyState
                    onAdd={handleAdd}
                    onImport={handleImport}
                />
            )}
        </PageComponentLayout>
    );
}

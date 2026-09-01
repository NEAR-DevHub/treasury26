"use client";

import { Icon } from "@/components/icon";
import {
    ArrowLeftRightIcon,
    ArrowRight01Icon,
    Cancel01Icon,
    HelpCircleIcon,
    SearchMinusIcon,
    SentIcon,
    CheckIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Proposal } from "@/lib/proposals-api";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { Button } from "@/components/button";
import { TransactionCell } from "./transaction-cell";
import { RequestDetailsSheet } from "./request-details/request-details-sheet";
import { ProposalTypeIcon } from "./proposal-type-icon";
import { VotingIndicator } from "./voting-indicator";
import { Policy } from "@/types/policy";
import { TreasuryConfig } from "@/lib/api";

import { TooltipUser } from "@/components/user";
import { Checkbox } from "@/components/ui/checkbox";
import { getProposalStatus, getProposalUIKind } from "../utils/proposal-utils";
import { useProposalKindLabel } from "../hooks/use-proposal-kind-label";
import { extractConfidentialRequestData } from "../utils/proposal-extractors";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Pagination } from "@/components/pagination";
import { TableSheet, sheetCellClassName } from "@/components/table-sheet";
import { ProposalCard } from "./proposal-card";
import { ProposalStatusPill } from "./proposal-status-pill";
import { ProposalTimelineDate } from "./proposal-timeline-date";
import { useNear } from "@/stores/near-store";
import { buildDepositDeepLink } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-transfer-url";
import { useTreasury } from "@/hooks/use-treasury";
import {
    getApproversAndThreshold,
    getKindFromProposal,
} from "@/lib/config-utils";

import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    useReactTable,
    createColumnHelper,
    getPaginationRowModel,
} from "@tanstack/react-table";
import { VoteModal } from "./vote-modal";
import { Address } from "@/components/address";
import { EmptyState } from "@/components/empty-state";
import { AuthButton } from "@/components/auth-button";
import { useRouter } from "next/navigation";
import { Tooltip } from "@/components/tooltip";
import { useProposalsInsufficientBalance } from "../hooks/use-proposals-insufficient-balance";
import { HighlightedText } from "@/components/highlighted-text";
import { cn } from "@/lib/utils";
import { useVoteActionSlots } from "@/features/proposals/hooks/use-vote-action-slots";

const columnHelper = createColumnHelper<Proposal>();

/** Width and padding per column, from the design. Shared by header and body. */
const COLUMN_CLASS: Record<string, string> = {
    select: "w-10 px-3",
    id: "px-3",
    transaction: "px-4",
    proposer: "px-3",
    voting: "w-[200px] px-3",
    status: "w-[132px] px-3",
    expand: "w-[60px] px-3",
};

const HEAD_CLASS =
    "h-10 text-sm font-semibold normal-case leading-[1.5] text-general-secondary-foreground";

interface ProposalsTableProps {
    proposals: Proposal[];
    policy: Policy;
    config?: TreasuryConfig | null;
    withFilters?: boolean;
    /** Active requests search query — used to highlight matching text. */
    searchQuery?: string;
    pageIndex?: number;
    pageSize?: number;
    total?: number;
    onPageChange?: (page: number) => void;
    onSelectionChange?: (count: number) => void;
}

export function ProposalsTable({
    proposals,
    policy,
    withFilters = false,
    searchQuery = "",
    pageIndex = 0,
    pageSize = 10,
    total = 0,
    onPageChange,
    onSelectionChange,
}: ProposalsTableProps) {
    const tT = useTranslations("requests.table");
    const tCommon = useTranslations("common");
    const getProposalKindLabel = useProposalKindLabel();
    const [rowSelection, setRowSelection] = useState({});
    // The request whose details sheet is open, held by id so the sheet keeps
    // reading the freshest copy after a vote invalidates the list.
    const [openProposalId, setOpenProposalId] = useState<number | null>(null);
    const { accountId } = useNear();
    const { treasuryId, isConfidential } = useTreasury();
    const router = useRouter();

    // The sheet serves both layouts — a panel on the right on desktop, a sheet
    // rising from the bottom edge on a phone — so a row opens it either way.
    const openRequest = useCallback((proposal: Proposal) => {
        setOpenProposalId(proposal.id);
    }, []);

    const handleDeposit = useCallback(
        (tokenSymbol?: string, tokenNetwork?: string) => {
            router.push(
                buildDepositDeepLink(
                    treasuryId!,
                    isConfidential
                        ? null
                        : { token: tokenSymbol, network: tokenNetwork },
                ),
            );
        },
        [router, treasuryId, isConfidential],
    );
    // Global action.approve / action.reject pause all requests — disable bulk
    // CTAs instead of opening the vote modal only to show the warning.
    const { approve: approveSlot, reject: rejectSlot } = useVoteActionSlots();
    const columns = useMemo<ColumnDef<Proposal, any>[]>(
        () => [
            columnHelper.display({
                id: "select",
                header: ({ table }) => {
                    // Only show header checkbox if at least one row can be selected
                    const hasSelectableRows = table
                        .getRowModel()
                        .rows.some((row) => row.getCanSelect());

                    if (!hasSelectableRows) {
                        return null;
                    }

                    return (
                        <Checkbox
                            checked={
                                table.getIsAllPageRowsSelected() ||
                                (table.getIsSomePageRowsSelected() &&
                                    "indeterminate")
                            }
                            onCheckedChange={(value) =>
                                table.toggleAllPageRowsSelected(!!value)
                            }
                            aria-label={tT("selectAll")}
                        />
                    );
                },
                cell: ({ row }) => {
                    const proposal = row.original;
                    const proposalKind =
                        getKindFromProposal(proposal.kind) ?? "call";
                    const { approverAccounts } = getApproversAndThreshold(
                        policy,
                        accountId ?? "",
                        proposalKind,
                        false,
                    );
                    const proposalStatus = getProposalStatus(proposal, policy);
                    const isVoted = Object.keys(proposal.votes).includes(
                        accountId ?? "",
                    );
                    const canVote =
                        approverAccounts.includes(accountId ?? "") &&
                        accountId &&
                        treasuryId;
                    const isPending = proposalStatus === "Pending";

                    if (isVoted || !canVote || !isPending) {
                        const content = !isPending
                            ? tT("notPending")
                            : !canVote
                              ? tT("noPermissionVote")
                              : isVoted
                                ? tT("alreadyVoted")
                                : "";

                        return (
                            <Tooltip content={content}>
                                <Checkbox
                                    checked={row.getIsSelected()}
                                    disabled={true}
                                    onCheckedChange={(value) =>
                                        row.toggleSelected(!!value)
                                    }
                                />
                            </Tooltip>
                        );
                    }

                    return (
                        <Checkbox
                            checked={row.getIsSelected()}
                            onCheckedChange={(value) =>
                                row.toggleSelected(!!value)
                            }
                            aria-label={tT("selectRow")}
                        />
                    );
                },
                enableSorting: false,
                enableHiding: false,
            }),
            columnHelper.accessor("id", {
                header: () => tT("request"),
                cell: (info) => {
                    const proposal = info.row.original;
                    const kind = getProposalUIKind(proposal);
                    const title: string =
                        kind === "Confidential Request"
                            ? extractConfidentialRequestData(
                                  proposal,
                                  treasuryId,
                              ).title
                            : getProposalKindLabel(kind);
                    return (
                        // `min-w-0` lets the title/date column shrink; without it
                        // the fixed-width cell overflows into `Transaction`.
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 text-sm font-medium text-general-secondary-foreground">
                                #
                                <HighlightedText
                                    text={String(proposal.id)}
                                    query={searchQuery}
                                />
                            </span>
                            <ProposalTypeIcon
                                proposal={proposal}
                                treasuryId={treasuryId}
                            />
                            <div className="flex min-w-0 flex-col items-start">
                                <HighlightedText
                                    text={title}
                                    query={searchQuery}
                                    className="max-w-full truncate text-sm font-semibold"
                                />
                                <ProposalTimelineDate
                                    proposal={proposal}
                                    policy={policy}
                                    className="truncate text-sm font-medium text-general-secondary-foreground"
                                />
                            </div>
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "transaction",
                header: () => tT("transaction"),
                cell: ({ row }) => (
                    <div className="min-w-0">
                        <TransactionCell proposal={row.original} />
                    </div>
                ),
            }),
            columnHelper.accessor("proposer", {
                header: () => tT("requester"),
                cell: (info) => {
                    const value = info.getValue();
                    return (
                        <TooltipUser
                            accountId={value}
                            triggerProps={{ asChild: false }}
                        >
                            <Address
                                address={value}
                                className="min-w-0 truncate text-sm font-semibold"
                            />
                        </TooltipUser>
                    );
                },
            }),
            columnHelper.display({
                id: "voting",
                header: () => (
                    <span className="flex items-center gap-2">
                        {tT("voting")}
                        <Tooltip content={tT("votingTooltip")}>
                            <Icon
                                icon={HelpCircleIcon}
                                className="size-4 text-general-muted-foreground"
                            />
                        </Tooltip>
                    </span>
                ),
                cell: ({ row }) => (
                    <VotingIndicator proposal={row.original} policy={policy} />
                ),
            }),
            columnHelper.accessor("status", {
                header: () => tT("status"),
                cell: (info) => (
                    <ProposalStatusPill
                        proposal={info.row.original}
                        policy={policy}
                    />
                ),
            }),
            columnHelper.display({
                id: "expand",
                cell: ({ row }) => (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openRequest(row.original)}
                        className="size-9 rounded-xl p-0"
                    >
                        <Icon
                            icon={ArrowRight01Icon}
                            className="text-muted-foreground"
                        />
                    </Button>
                ),
            }),
        ],
        [
            policy,
            accountId,
            treasuryId,
            openRequest,
            searchQuery,
            getProposalKindLabel,
            tT,
        ],
    );

    const table = useReactTable({
        data: proposals,
        columns,
        state: {
            rowSelection,
            pagination: {
                pageIndex,
                pageSize,
            },
        },
        getPaginationRowModel: getPaginationRowModel(),
        onRowSelectionChange: setRowSelection,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row.id.toString(),
        manualPagination: true,
        enableRowSelection: (row) => {
            const proposal = row.original;
            const { approverAccounts } = getApproversAndThreshold(
                policy,
                accountId ?? "",
                proposal.kind,
                false,
            );
            const isVoted = Object.keys(proposal.votes).includes(
                accountId ?? "",
            );
            const proposalStatus = getProposalStatus(proposal, policy);
            return (
                approverAccounts.includes(accountId ?? "") &&
                !isVoted &&
                !!accountId &&
                !!treasuryId &&
                proposal.status === "InProgress" &&
                proposalStatus !== "Expired"
            );
        },
    });

    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [voteInfo, setVoteInfo] = useState<{
        vote: "Approve" | "Reject" | "Remove";
        proposals: Proposal[];
        insufficientBalanceIds?: number[];
    }>({ vote: "Approve", proposals: [] });

    // Notify parent when selection changes
    const selectedRows = table.getFilteredSelectedRowModel().rows;
    useEffect(() => {
        const selectedCount = selectedRows.length;
        onSelectionChange?.(selectedCount);
    }, [selectedRows.length, onSelectionChange]);

    const { insufficientBalanceIds } = useProposalsInsufficientBalance(
        proposals,
        treasuryId,
    );

    if ((proposals.length === 0 && pageIndex === 0) || total === 0) {
        return withFilters ? (
            <TableSheet>
                <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-general-border bg-card py-8">
                    <EmptyState
                        icon={SearchMinusIcon}
                        title=""
                        description={tT("noResults")}
                    />
                </div>
            </TableSheet>
        ) : (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
                <EmptyState
                    icon={SentIcon}
                    title={tT("allCaughtUp")}
                    description={tT("noPending")}
                    className="pb-0"
                />
                <div className="flex gap-4 w-full max-w-[300px] min-w-0 pb-12">
                    <AuthButton
                        permissionKind="transfer"
                        onClick={() => router.push(`/${treasuryId}/payments`)}
                        permissionAction="AddProposal"
                        className="gap-1 w-full shrink"
                    >
                        <Icon icon={SentIcon} /> {tT("send")}
                    </AuthButton>
                    <AuthButton
                        permissionKind="call"
                        onClick={() => router.push(`/${treasuryId}/exchange`)}
                        permissionAction="AddProposal"
                        className="gap-1 w-full shrink"
                    >
                        <Icon icon={ArrowLeftRightIcon} /> {tT("exchange")}
                    </AuthButton>
                </div>
            </div>
        );
    }

    const totalPages = Math.ceil(total / pageSize);
    const tableRows = table.getRowModel().rows;
    const selectedCount = table.getFilteredSelectedRowModel().rows.length;
    const selectedProposals = table
        .getFilteredSelectedRowModel()
        .rows.map((row) => row.original);

    const selectedInsufficientIds = selectedProposals
        .map((p) => p.id)
        .filter((id) => insufficientBalanceIds.has(id));

    const allSelectedHaveInsufficientBalance =
        selectedCount > 0 && selectedInsufficientIds.length === selectedCount;

    const handleBulkVote = async (vote: "Approve" | "Reject") => {
        if (!treasuryId || !accountId) return;

        setVoteInfo({
            vote,
            proposals: selectedProposals,
            insufficientBalanceIds:
                vote === "Approve" ? selectedInsufficientIds : undefined,
        });
        setIsVoteModalOpen(true);
    };

    return (
        <>
            <div className="flex flex-col gap-2">
                {selectedCount > 0 && (
                    <div className="flex items-center justify-between rounded-xl border border-general-border bg-card px-4 py-3 text-sm md:text-base">
                        <span className="font-semibold">
                            {tT("requestsSelected", { count: selectedCount })}
                        </span>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="secondary"
                                onClick={() => handleBulkVote("Reject")}
                                disabled={rejectSlot.blocked}
                                tooltipContent={rejectSlot.blockedTooltip}
                            >
                                <Icon icon={Cancel01Icon} />
                                {tCommon("reject")}
                            </Button>

                            <Button
                                variant="default"
                                tooltipContent={
                                    approveSlot.blockedTooltip ??
                                    (allSelectedHaveInsufficientBalance
                                        ? tT("bulkApproveDisabled")
                                        : undefined)
                                }
                                onClick={() => handleBulkVote("Approve")}
                                disabled={
                                    allSelectedHaveInsufficientBalance ||
                                    approveSlot.blocked
                                }
                            >
                                <Icon icon={CheckIcon} />
                                {tCommon("approve")}
                            </Button>
                        </div>
                    </div>
                )}

                {/* Mobile: the seven columns restack into one card per request. */}
                <div className="flex flex-col gap-3 lg:hidden">
                    {tableRows.map((row) => (
                        <ProposalCard
                            key={row.id}
                            proposal={row.original}
                            policy={policy}
                            searchQuery={searchQuery}
                            onOpen={openRequest}
                        />
                    ))}
                </div>

                <TableSheet className="hidden lg:block">
                    <ScrollArea className="grid">
                        <Table className="border-separate border-spacing-0 md:table-fixed">
                            <TableHeader className="border-0 bg-transparent">
                                {table.getHeaderGroups().map((headerGroup) => (
                                    <TableRow
                                        key={headerGroup.id}
                                        className="border-0 hover:bg-transparent"
                                    >
                                        {headerGroup.headers.map((header) => (
                                            <TableHead
                                                key={header.id}
                                                className={cn(
                                                    HEAD_CLASS,
                                                    COLUMN_CLASS[
                                                        header.column.id
                                                    ],
                                                )}
                                            >
                                                {header.isPlaceholder
                                                    ? null
                                                    : flexRender(
                                                          header.column
                                                              .columnDef.header,
                                                          header.getContext(),
                                                      )}
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableHeader>
                            <TableBody>
                                {tableRows.map((row, rowIndex) => {
                                    const isFirstRow = rowIndex === 0;
                                    const isLastRow =
                                        rowIndex === tableRows.length - 1;
                                    const cells = row.getVisibleCells();
                                    return (
                                        <TableRow
                                            key={row.id}
                                            data-state={
                                                row.getIsSelected() &&
                                                "selected"
                                            }
                                            onClick={(e) => {
                                                const target =
                                                    e.target as HTMLElement;
                                                if (
                                                    target.closest("button") ||
                                                    target.closest(
                                                        '[role="checkbox"]',
                                                    ) ||
                                                    target.tagName === "INPUT"
                                                ) {
                                                    return;
                                                }
                                                openRequest(row.original);
                                            }}
                                            className="group cursor-pointer border-0 hover:bg-transparent"
                                        >
                                            {cells.map((cell, columnIndex) => (
                                                <TableCell
                                                    key={cell.id}
                                                    className={cn(
                                                        "h-[66px] group-data-[state=selected]:bg-general-tertiary",
                                                        sheetCellClassName({
                                                            isFirstRow,
                                                            isLastRow,
                                                            isFirstColumn:
                                                                columnIndex ===
                                                                0,
                                                            isLastColumn:
                                                                columnIndex ===
                                                                cells.length -
                                                                    1,
                                                        }),
                                                        COLUMN_CLASS[
                                                            cell.column.id
                                                        ],
                                                    )}
                                                >
                                                    {flexRender(
                                                        cell.column.columnDef
                                                            .cell,
                                                        cell.getContext(),
                                                    )}
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                        <ScrollBar orientation="horizontal" />
                    </ScrollArea>
                </TableSheet>

                {onPageChange && totalPages > 1 && (
                    <Pagination
                        pageIndex={pageIndex}
                        totalPages={totalPages}
                        onPageChange={onPageChange}
                    />
                )}
            </div>
            <RequestDetailsSheet
                proposal={
                    proposals.find((p) => p.id === openProposalId) ?? null
                }
                policy={policy}
                onOpenChange={(open) => !open && setOpenProposalId(null)}
                onVote={(proposal, vote) => {
                    setVoteInfo({ vote, proposals: [proposal] });
                    setIsVoteModalOpen(true);
                }}
                onDeposit={handleDeposit}
            />
            <VoteModal
                isOpen={isVoteModalOpen}
                onClose={() => setIsVoteModalOpen(false)}
                onSuccess={() => {
                    table.setRowSelection({});
                    onSelectionChange?.(0);
                }}
                proposals={voteInfo.proposals}
                vote={voteInfo.vote}
                insufficientBalanceProposalIds={voteInfo.insufficientBalanceIds}
            />
        </>
    );
}

"use client";

import { type IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/icon";
import {
    Add01Icon,
    Cancel01Icon,
    Delete01Icon,
    Edit03Icon,
    InformationCircleIcon,
    Key02Icon,
    LockIcon,
    SentIcon,
    ShieldUserIcon,
    UserAdd01Icon,
    Wallet03Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { PageComponentLayout } from "@/components/page-component-layout";
import Link from "next/link";
import { APP_DOCS_URL } from "@/constants/config";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportError } from "@/lib/report-error";
import { encodeToMarkdown } from "@/lib/utils";
import { DeleteConfirmationModal } from "./components/modals/delete-confirmation-modal";
import { User } from "@/components/user";
import { Checkbox } from "@/components/ui/checkbox";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { RoleBadge } from "@/components/role-badge";
import { Tooltip } from "@/components/tooltip";
import { PendingButton } from "@/components/pending-button";
import { useMemberJoinRequests } from "@/hooks/use-member-invites";
import { removeMembersFromPolicy } from "./utils/policy-helpers";
import {
    usePageTour,
    PAGE_TOUR_NAMES,
    PAGE_TOUR_STORAGE_KEYS,
} from "@/features/onboarding/steps/page-tours";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { useMemberPolicyGate } from "./hooks/use-member-policy-gate";
import { useMemberValidation } from "./hooks/use-member-validation";
import { AuthButton } from "@/components/auth-button";
import type { RolePermission } from "@/types/policy";
import { sortRolesByOrder } from "@/lib/role-utils";
import { useRoleDescription } from "@/lib/use-role-description";
import { useFormatRoleName } from "@/components/role-name";
import { StepperHeader } from "@/components/step-wizard";
import { NumberBadge } from "@/components/number-badge";
import { useSearchParams, useRouter } from "next/navigation";
import { trackEvent } from "@/lib/analytics";
import { useMediaQuery } from "@/hooks/use-media-query";

interface Member {
    accountId: string;
    roles: string[];
}

const MEMBERS_INFO_DISMISSED_STORAGE_KEY = "members-info-dismissed";

type MembersInfoItem = {
    icon: IconSvgElement;
    title: string;
    description: string;
};

function PermissionsHeader({ policyRoles }: { policyRoles: RolePermission[] }) {
    const tMembers = useTranslations("members");
    const formatRoleName = useFormatRoleName();
    const getRoleDescription = useRoleDescription();
    // Get role descriptions and sort them
    const roleNames = policyRoles.map((r) => r.name);
    const sortedRoleNames = sortRolesByOrder(roleNames);

    const sortedDescriptions = sortedRoleNames
        .map((name) => ({
            name,
            description: getRoleDescription(name) || "",
        }))
        .filter((r) => r.description); // Only include roles with descriptions

    return (
        <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium uppercase text-muted-foreground">
                {tMembers("permissions")}
            </span>
            {sortedDescriptions.length > 0 && (
                <Tooltip
                    content={
                        <div className="space-y-3">
                            {sortedDescriptions.map((role) => (
                                <div key={role.name}>
                                    <p className="font-semibold mb-1">
                                        {formatRoleName(role.name)}
                                    </p>
                                    <p className="text-xs">
                                        {role.description}
                                    </p>
                                </div>
                            ))}
                        </div>
                    }
                    contentProps={{ className: "max-w-[320px]" }}
                >
                    <Icon
                        icon={InformationCircleIcon}
                        className="text-muted-foreground cursor-help"
                    />
                </Tooltip>
            )}
        </div>
    );
}

export default function MembersPage() {
    const t = useTranslations("pages.members");
    const tMembers = useTranslations("members");
    const tMemberValidation = useTranslations("memberValidation");
    const { treasuryId } = useTreasury();
    const { createProposal } = useNear();
    const {
        policy,
        isLoading,
        accountId,
        existingMembers,
        hasPendingMemberRequest,
        isMemberDataReady,
        isMemberActionsDisabled,
        canAddMember,
        availableRoles,
    } = useMemberPolicyGate(treasuryId);
    const queryClient = useQueryClient();
    const searchParams = useSearchParams();
    const router = useRouter();
    const isMobile = useMediaQuery("(max-width: 640px)");

    usePageTour(
        PAGE_TOUR_NAMES.MEMBERS_PENDING,
        PAGE_TOUR_STORAGE_KEYS.MEMBERS_PENDING_SHOWN,
    );
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [isInfoSectionDismissed, setIsInfoSectionDismissed] = useState(false);
    const [memberToDelete, setMemberToDelete] = useState<Member | null>(null);
    const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

    // Track if we've already processed URL params to avoid re-navigating
    const hasProcessedUrlParams = useRef(false);

    const memberActionsDisabledReason = hasPendingMemberRequest
        ? tMemberValidation("pendingRequest")
        : undefined;

    const { data: joinRequests = [] } = useMemberJoinRequests(
        canAddMember ? treasuryId : undefined,
    );
    const joinRequestCount = joinRequests.length;

    const membersInfoItems = useMemo<MembersInfoItem[]>(
        () => [
            {
                icon: LockIcon,
                title: tMembers("infoSection.strongerProtectionTitle"),
                description: tMembers(
                    "infoSection.strongerProtectionDescription",
                ),
            },
            {
                icon: ShieldUserIcon,
                title: tMembers("infoSection.rolesForEveryoneTitle"),
                description: tMembers(
                    "infoSection.rolesForEveryoneDescription",
                ),
            },
            {
                icon: Key02Icon,
                title: tMembers("infoSection.neverLoseAccessTitle"),
                description: tMembers("infoSection.neverLoseAccessDescription"),
            },
        ],
        [tMembers],
    );

    useEffect(() => {
        if (typeof window === "undefined") return;
        const value = window.localStorage.getItem(
            MEMBERS_INFO_DISMISSED_STORAGE_KEY,
        );
        setIsInfoSectionDismissed(value === "true");
    }, []);

    const dismissMembersInfoSection = useCallback(() => {
        setIsInfoSectionDismissed(true);
        if (typeof window === "undefined") return;
        window.localStorage.setItem(MEMBERS_INFO_DISMISSED_STORAGE_KEY, "true");
    }, []);

    // Deep-link: /members?member=...&roles=... → /members/add
    useEffect(() => {
        const memberParam = searchParams.get("member");
        const rolesParam = searchParams.get("roles");

        if (
            memberParam &&
            canAddMember &&
            !isMemberActionsDisabled &&
            !hasProcessedUrlParams.current
        ) {
            hasProcessedUrlParams.current = true;
            const params = new URLSearchParams();
            params.set("member", memberParam);
            if (rolesParam) params.set("roles", rolesParam);
            router.replace(`/${treasuryId}/members/add?${params.toString()}`);
        }
    }, [
        searchParams,
        canAddMember,
        isMemberActionsDisabled,
        router,
        treasuryId,
    ]);

    const { canModifyMember, canDeleteBulk } = useMemberValidation(
        existingMembers,
        {
            accountId: accountId || undefined,
            canAddMember,
            hasPendingMemberRequest,
        },
    );

    // Generic function to create policy change proposal
    const createPolicyChangeProposal = async (
        updatedPolicy: any,
        summary: string,
        title: string,
        successMessage: string,
    ) => {
        if (!policy || !treasuryId) return;

        try {
            const description = {
                title,
                summary,
            };

            const proposalBond = policy?.proposal_bond || "0";

            await createProposal(successMessage, {
                treasuryId,
                proposalBond,
                proposal: {
                    description: encodeToMarkdown(description),
                    kind: {
                        ChangePolicy: {
                            policy: updatedPolicy,
                        },
                    },
                },
                proposalType: "other",
            });

            // Refetch proposals to show the newly created proposal
            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });
        } catch (error) {
            reportError(error, "Failed to create proposal");
            toast.error(tMembers("policy.createProposalFailed"));
            throw error;
        }
    };

    // Handle delete members submission
    const handleDeleteMembersSubmit = async () => {
        if (!policy || !treasuryId || isMemberActionsDisabled) return;

        try {
            const membersToRemove =
                selectedMembers.length > 0
                    ? selectedMembers.map((accountId) => {
                          const member = existingMembers.find(
                              (m) => m.accountId === accountId,
                          );
                          return {
                              member: accountId,
                              roles: member?.roles || [],
                          };
                      })
                    : memberToDelete
                      ? [
                            {
                                member: memberToDelete.accountId,
                                roles: memberToDelete.roles,
                            },
                        ]
                      : [];

            if (membersToRemove.length === 0) return;

            const { updatedPolicy, summary } = removeMembersFromPolicy(
                policy,
                membersToRemove,
            );

            await createPolicyChangeProposal(
                updatedPolicy,
                summary,
                membersToRemove.length > 1
                    ? tMembers("policy.removeMembers")
                    : tMembers("policy.removeMember"),
                tMembers("policy.removeMemberSuccess"),
            );

            trackEvent("member-delete-submitted", {
                treasury_id: treasuryId,
                members_count: membersToRemove.length,
            });

            setIsDeleteModalOpen(false);
            setMemberToDelete(null);
            setSelectedMembers([]);
        } catch {
            // Toast + Sentry already handled in createPolicyChangeProposal
        }
    };

    const handleEditMember = useCallback(
        (member: Member) => {
            if (isMemberActionsDisabled || !treasuryId) return;
            router.push(
                `/${treasuryId}/members/edit?members=${encodeURIComponent(member.accountId)}`,
            );
        },
        [isMemberActionsDisabled, router, treasuryId],
    );

    const handleBulkEdit = useCallback(() => {
        if (
            isMemberActionsDisabled ||
            !treasuryId ||
            selectedMembers.length === 0
        )
            return;
        const membersParam = selectedMembers
            .map((id) => encodeURIComponent(id))
            .join(",");
        router.push(`/${treasuryId}/members/edit?members=${membersParam}`);
    }, [isMemberActionsDisabled, router, treasuryId, selectedMembers]);

    // Handle bulk delete
    const handleBulkDelete = useCallback(() => {
        if (isMemberActionsDisabled) return;
        setIsDeleteModalOpen(true);
    }, [isMemberActionsDisabled]);

    // Handle checkbox toggle
    const handleToggleMember = useCallback((accountId: string) => {
        setSelectedMembers((prev) =>
            prev.includes(accountId)
                ? prev.filter((id) => id !== accountId)
                : [...prev, accountId],
        );
    }, []);

    // Handle select all
    const handleToggleAll = useCallback(() => {
        if (selectedMembers.length === existingMembers.length) {
            setSelectedMembers([]);
        } else {
            setSelectedMembers(existingMembers.map((m) => m.accountId));
        }
    }, [selectedMembers.length, existingMembers]);

    // Validate bulk delete
    const bulkDeleteValidation = useMemo(() => {
        if (selectedMembers.length === 0) return { canModify: true };

        const membersToDelete = existingMembers.filter((m) =>
            selectedMembers.includes(m.accountId),
        );

        return canDeleteBulk(membersToDelete);
    }, [selectedMembers, existingMembers, canDeleteBulk]);

    // Render members table
    const renderMembersTable = (members: Member[]) => {
        if (isLoading) {
            return (
                <Table>
                    <TableHeader className="bg-general-tertiary">
                        <TableRow className="hover:bg-transparent">
                            <TableHead className="w-12"></TableHead>
                            <TableHead className="w-1/2">
                                <span className="text-xs font-medium uppercase text-muted-foreground">
                                    {tMembers("member")}
                                </span>
                            </TableHead>
                            <TableHead>
                                <PermissionsHeader
                                    policyRoles={availableRoles}
                                />
                            </TableHead>
                            <TableHead className="w-24 pr-6 hidden md:table-cell"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {[...Array(5)].map((_, i) => (
                            <TableRow key={i}>
                                <TableCell className="pl-6">
                                    <div className="w-4 h-4 bg-general-unofficial-accent-0 rounded animate-pulse" />
                                </TableCell>
                                <TableCell>
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-general-unofficial-accent-0 animate-pulse" />
                                        <div className="space-y-2 flex-1">
                                            <div className="h-4 bg-general-unofficial-accent-0 rounded w-48 animate-pulse" />
                                            <div className="h-3 bg-general-unofficial-accent-0 rounded w-32 animate-pulse" />
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell className="pr-6 md:pr-0">
                                    <div className="flex gap-2">
                                        <div className="h-7 bg-general-unofficial-accent-0 rounded w-20 animate-pulse" />
                                        <div className="h-7 bg-general-unofficial-accent-0 rounded w-24 animate-pulse" />
                                    </div>
                                </TableCell>
                                <TableCell className="pr-6 hidden md:table-cell">
                                    <div className="flex justify-end gap-2">
                                        <div className="w-8 h-8 bg-general-unofficial-accent-0 rounded animate-pulse" />
                                        <div className="w-8 h-8 bg-general-unofficial-accent-0 rounded animate-pulse" />
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            );
        }

        if (members.length === 0) {
            return (
                <div className="flex items-center justify-center py-8">
                    <p className="text-muted-foreground">
                        {tMembers("noActiveMembers")}
                    </p>
                </div>
            );
        }

        return (
            <Table>
                <TableHeader className="bg-general-tertiary">
                    <TableRow className="hover:bg-transparent">
                        <TableHead className="w-12 pl-6">
                            <Checkbox
                                checked={
                                    selectedMembers.length ===
                                        existingMembers.length &&
                                    existingMembers.length > 0
                                        ? true
                                        : selectedMembers.length > 0
                                          ? "indeterminate"
                                          : false
                                }
                                onCheckedChange={handleToggleAll}
                            />
                        </TableHead>
                        <TableHead className="w-1/2">
                            <span className="text-xs font-medium uppercase text-muted-foreground">
                                {tMembers("member")}
                            </span>
                        </TableHead>
                        <TableHead>
                            <PermissionsHeader policyRoles={availableRoles} />
                        </TableHead>
                        <TableHead className="w-24 pr-6 hidden md:table-cell"></TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {members.map((member) => {
                        const deleteValidation = canModifyMember(member);
                        const editValidation = canModifyMember(
                            member,
                            member.roles,
                        ); // Pass roles to trigger edit check

                        return (
                            <TableRow key={member.accountId} className="group">
                                <TableCell className="pl-6">
                                    <Checkbox
                                        checked={selectedMembers.includes(
                                            member.accountId,
                                        )}
                                        onCheckedChange={() =>
                                            handleToggleMember(member.accountId)
                                        }
                                    />
                                </TableCell>
                                <TableCell>
                                    <User
                                        accountId={member.accountId}
                                        size="md"
                                        withLink={false}
                                        withHoverCard={true}
                                    />
                                </TableCell>
                                <TableCell className="pr-6 md:pr-0">
                                    <div className="flex gap-2">
                                        {sortRolesByOrder(member.roles).map(
                                            (role) => (
                                                <RoleBadge
                                                    key={role}
                                                    role={role}
                                                    variant="pill"
                                                    showTooltip={false}
                                                />
                                            ),
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="pr-6 hidden md:table-cell">
                                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <AuthButton
                                            permissionKind="policy"
                                            permissionAction="AddProposal"
                                            balanceCheck={{
                                                withProposalBond: true,
                                            }}
                                            variant="ghost"
                                            size="icon"
                                            onClick={() =>
                                                handleEditMember(member)
                                            }
                                            disabled={
                                                isMemberActionsDisabled ||
                                                !editValidation.canModify
                                            }
                                            className="h-8 w-8"
                                            tooltip={
                                                memberActionsDisabledReason ||
                                                editValidation.reason
                                            }
                                            tooltipProps={{
                                                disabled:
                                                    (!isMemberActionsDisabled &&
                                                        editValidation.canModify) ||
                                                    !(
                                                        memberActionsDisabledReason ||
                                                        editValidation.reason
                                                    ) ||
                                                    !canAddMember,
                                                contentProps: {
                                                    className: "max-w-[280px]",
                                                },
                                            }}
                                        >
                                            <Icon icon={Edit03Icon} />
                                        </AuthButton>
                                        <AuthButton
                                            permissionKind="policy"
                                            permissionAction="AddProposal"
                                            balanceCheck={{
                                                withProposalBond: true,
                                            }}
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => {
                                                if (isMemberActionsDisabled)
                                                    return;
                                                setMemberToDelete(member);
                                                setIsDeleteModalOpen(true);
                                            }}
                                            disabled={
                                                isMemberActionsDisabled ||
                                                !deleteValidation.canModify
                                            }
                                            className="h-8 w-8"
                                            tooltip={
                                                memberActionsDisabledReason ||
                                                deleteValidation.reason
                                            }
                                            tooltipProps={{
                                                disabled:
                                                    (!isMemberActionsDisabled &&
                                                        deleteValidation.canModify) ||
                                                    !(
                                                        memberActionsDisabledReason ||
                                                        deleteValidation.reason
                                                    ) ||
                                                    !canAddMember,
                                                contentProps: {
                                                    className: "max-w-[280px]",
                                                },
                                            }}
                                        >
                                            <Icon
                                                icon={Delete01Icon}
                                                className="text-destructive"
                                            />
                                        </AuthButton>
                                    </div>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        );
    };

    return (
        <PageComponentLayout
            title={t("title")}
            description={t("description")}
            hideHeaderOnMobile
        >
            <h1 className="mb-4 text-2xl font-semibold leading-tight tracking-tight text-general-foreground lg:hidden">
                {t("title")}
            </h1>
            {!isInfoSectionDismissed && canAddMember && (
                <PageCard className="py-4 px-6 gap-3 bg-general-tertiary mb-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                            <h2 className="text-base font-semibold">
                                {tMembers("infoSection.title")}
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                {tMembers("infoSection.description")}
                            </p>
                        </div>
                        <div className="flex items-center gap-3">
                            <Link
                                href={`${APP_DOCS_URL}/governance/members-and-roles`}
                                target="_blank"
                                className="hidden md:inline-flex text-sm font-medium underline-offset-2"
                            >
                                {tMembers("infoSection.readGuide")}
                            </Link>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-8 text-muted-foreground hover:text-foreground"
                                aria-label={tMembers("infoSection.dismiss")}
                                onClick={dismissMembersInfoSection}
                            >
                                <Icon icon={Cancel01Icon} />
                            </Button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        {membersInfoItems.map((item) => {
                            const { icon, title, description } = item;
                            return (
                                <div
                                    key={title}
                                    className="rounded-lg border border-general-border p-3 bg-card"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                                            <Icon
                                                icon={icon}
                                                className="text-muted-foreground"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <p className="text-sm font-medium">
                                                {title}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {description}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <Link
                        href={`${APP_DOCS_URL}/governance/members-and-roles`}
                        target="_blank"
                        className="md:hidden inline-flex text-sm font-medium underline-offset-2 mt-2"
                    >
                        {tMembers("infoSection.readGuide")}
                    </Link>
                </PageCard>
            )}

            <PageCard className="gap-0 p-0">
                {/* Hide header when members are selected */}
                {!(selectedMembers.length > 0) && (
                    <div className="flex flex-row items-center justify-between gap-3 sm:gap-4 py-3.5 px-6 border-b">
                        <div className="flex items-center gap-2 w-fit">
                            <StepperHeader title={tMembers("activeMembers")} />
                            <NumberBadge
                                number={existingMembers.length}
                                variant="secondary"
                            />
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3">
                            <PendingButton
                                id="members-pending-btn"
                                types={["Change Policy"]}
                            />

                            {joinRequestCount > 0 && (
                                <AuthButton
                                    permissionKind="policy"
                                    permissionAction="AddProposal"
                                    balanceCheck={{ withProposalBond: true }}
                                    variant="ghost"
                                    disabled={!isMemberDataReady}
                                    onClick={() =>
                                        router.push(
                                            `/${treasuryId}/members/join-requests`,
                                        )
                                    }
                                    className="flex items-center gap-2 border-2"
                                >
                                    <span className="hidden sm:inline">
                                        {tMembers("wantsToJoin")}
                                    </span>
                                    <Icon
                                        icon={UserAdd01Icon}
                                        className="sm:hidden"
                                    />
                                    <NumberBadge
                                        shape="pill"
                                        number={joinRequestCount}
                                    />
                                </AuthButton>
                            )}

                            {!canAddMember || !isMemberDataReady ? (
                                <AuthButton
                                    permissionKind="policy"
                                    permissionAction="AddProposal"
                                    balanceCheck={{ withProposalBond: true }}
                                    disabled={!isMemberDataReady}
                                    size={isMobile ? "icon" : "default"}
                                    className="size-9 sm:w-auto"
                                >
                                    <Icon icon={Add01Icon} />
                                    <span className="hidden sm:inline">
                                        {tMembers("addNewMember")}
                                    </span>
                                </AuthButton>
                            ) : (
                                <DropdownMenu
                                    onOpenChange={(open) => {
                                        if (!open || !treasuryId) return;
                                        // Prefetch destinations so menu clicks feel instant.
                                        router.prefetch(
                                            `/${treasuryId}/members/add`,
                                        );
                                        router.prefetch(
                                            `/${treasuryId}/members/invite`,
                                        );
                                    }}
                                >
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            size={isMobile ? "icon" : "default"}
                                            className="size-9 sm:w-auto"
                                        >
                                            <Icon icon={Add01Icon} />
                                            <span className="hidden sm:inline">
                                                {tMembers("addNewMember")}
                                            </span>
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                        align="end"
                                        className="w-max min-w-(--radix-popper-anchor-width) p-2"
                                    >
                                        {hasPendingMemberRequest ? (
                                            <Tooltip
                                                content={
                                                    memberActionsDisabledReason
                                                }
                                                contentProps={{
                                                    className: "max-w-[280px]",
                                                }}
                                            >
                                                <span className="flex w-full cursor-not-allowed">
                                                    <DropdownMenuItem
                                                        disabled
                                                        className="w-full gap-2.5 px-3 py-2.5"
                                                    >
                                                        <Icon
                                                            icon={Wallet03Icon}
                                                        />
                                                        {tMembers(
                                                            "addManually",
                                                        )}
                                                    </DropdownMenuItem>
                                                </span>
                                            </Tooltip>
                                        ) : (
                                            <DropdownMenuItem
                                                asChild
                                                className="gap-2.5 px-3 py-2.5 cursor-pointer"
                                            >
                                                <Link
                                                    href={`/${treasuryId}/members/add`}
                                                    onClick={() =>
                                                        trackEvent(
                                                            "member-add-modal-opened",
                                                            {
                                                                treasury_id:
                                                                    treasuryId,
                                                            },
                                                        )
                                                    }
                                                >
                                                    <Icon icon={Wallet03Icon} />
                                                    {tMembers("addManually")}
                                                </Link>
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuItem
                                            asChild
                                            className="gap-2.5 px-3 py-2.5 cursor-pointer"
                                        >
                                            <Link
                                                href={`/${treasuryId}/members/invite`}
                                            >
                                                <Icon icon={SentIcon} />
                                                {tMembers("inviteMember")}
                                            </Link>
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                        </div>
                    </div>
                )}

                {/* Bulk Actions Bar */}
                {selectedMembers.length > 0 && (
                    <div className="flex items-center justify-between gap-4 py-3.5 px-8 border-b">
                        <span className="font-semibold text-base sm:text-lg">
                            {tMembers("membersSelected", {
                                count: selectedMembers.length,
                            })}
                        </span>
                        <div className="flex items-center gap-2 w-fit">
                            <Tooltip
                                content={
                                    memberActionsDisabledReason ||
                                    bulkDeleteValidation.reason
                                }
                                disabled={
                                    (!isMemberActionsDisabled &&
                                        bulkDeleteValidation.canModify) ||
                                    !(
                                        memberActionsDisabledReason ||
                                        bulkDeleteValidation.reason
                                    ) ||
                                    !canAddMember // Only show validation tooltip if user has permission
                                }
                                contentProps={{ className: "max-w-[280px]" }}
                            >
                                <span className="flex-1 sm:flex-none">
                                    <AuthButton
                                        permissionKind="policy"
                                        permissionAction="AddProposal"
                                        balanceCheck={{
                                            withProposalBond: true,
                                        }}
                                        variant="outline-destructive"
                                        size={isMobile ? "icon" : "sm"}
                                        onClick={handleBulkDelete}
                                        disabled={
                                            isMemberActionsDisabled ||
                                            !bulkDeleteValidation.canModify
                                        }
                                        className="size-9 sm:w-auto"
                                    >
                                        <Icon
                                            icon={Delete01Icon}
                                            className="mr-1"
                                        />
                                        <span className="hidden sm:inline">
                                            {tMembers("remove")}
                                        </span>
                                    </AuthButton>
                                </span>
                            </Tooltip>
                            <span className="flex-1 sm:flex-none">
                                <AuthButton
                                    permissionKind="policy"
                                    permissionAction="AddProposal"
                                    balanceCheck={{ withProposalBond: true }}
                                    variant="outline"
                                    size={isMobile ? "icon" : "sm"}
                                    onClick={handleBulkEdit}
                                    disabled={isMemberActionsDisabled}
                                    tooltip={memberActionsDisabledReason}
                                    className="size-9 sm:w-auto"
                                >
                                    <Icon icon={Edit03Icon} className="mr-1" />
                                    <span className="hidden sm:inline">
                                        {tMembers("edit")}
                                    </span>
                                </AuthButton>
                            </span>
                        </div>
                    </div>
                )}

                {/* Members Table */}
                {renderMembersTable(existingMembers)}
            </PageCard>

            {/* Delete Confirmation Modal */}
            <DeleteConfirmationModal
                isOpen={isDeleteModalOpen}
                onClose={() => {
                    setIsDeleteModalOpen(false);
                    setMemberToDelete(null);
                    setSelectedMembers([]);
                }}
                member={memberToDelete}
                members={
                    selectedMembers.length > 0
                        ? existingMembers.filter((m) =>
                              selectedMembers.includes(m.accountId),
                          )
                        : undefined
                }
                onConfirm={handleDeleteMembersSubmit}
                validationError={(() => {
                    const membersToDelete =
                        selectedMembers.length > 0
                            ? existingMembers.filter((m) =>
                                  selectedMembers.includes(m.accountId),
                              )
                            : memberToDelete
                              ? [memberToDelete]
                              : [];

                    if (membersToDelete.length === 0) return undefined;

                    const validation = canDeleteBulk(membersToDelete);
                    return validation.canModify ? undefined : validation.reason;
                })()}
            />
        </PageComponentLayout>
    );
}

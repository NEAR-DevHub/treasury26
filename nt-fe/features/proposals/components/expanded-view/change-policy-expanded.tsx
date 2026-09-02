"use client";

import { ArrowDown01Icon, LoaderCircleIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { Pill } from "@/components/pill";
import { formatRoleName } from "@/components/role-name";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import type { Proposal } from "@/lib/proposals-api";
import { cn, formatNanosecondDuration } from "@/lib/utils";
import type {
    ChangePolicyData,
    MemberRoleChange,
    PolicyChange,
    RoleDefinitionChange,
    VotePolicyChange,
} from "../../types/index";
import { isNullValue, renderDiff } from "../../utils/diff-utils";
import { computePolicyDiff } from "../../utils/policy-diff-utils";
import { Amount } from "../amount";
import {
    DetailRow,
    RequestParty,
    TransactionDetails,
} from "../request-details/primitives";
import { useRequestDisplayContext } from "./common/request-display-context";

interface ChangePolicyExpandedProps {
    data: ChangePolicyData;
    proposal: Proposal;
}

/** The permission chips the design gives a member's roles. */
const PERMISSION_PILL_CLASS =
    "rounded-sm border border-general-border bg-general-bg-secondary font-semibold text-general-secondary-foreground";

/** One line of the body: a label, and whatever describes the change. */
interface PolicyRow {
    label: string;
    value: ReactNode;
}

function formatFieldLabel(
    field: PolicyChange["field"],
    t: (key: string) => string,
): string {
    const labels: Record<PolicyChange["field"], string> = {
        proposal_bond: t("proposalBond"),
        // The policy calls it the proposal period; the product calls it what
        // members actually experience — how long they have to vote.
        proposal_period: t("votingDuration"),
        bounty_bond: t("bountyBond"),
        bounty_forgiveness_period: t("bountyForgivenessPeriod"),
    };
    return labels[field];
}

function formatFieldValue(
    field: PolicyChange["field"],
    value: string,
): React.ReactNode {
    if (isNullValue(value))
        return <span className="text-muted-foreground/50">null</span>;
    const isAmountField = field === "proposal_bond" || field === "bounty_bond";
    const isDurationField =
        field === "proposal_period" || field === "bounty_forgiveness_period";

    if (isAmountField) {
        return (
            <Amount
                amount={value}
                showNetworkTooltip
                tokenId={NEAR_NETWORK_ID}
            />
        );
    }
    if (isDurationField) {
        return <span>{formatNanosecondDuration(value)}</span>;
    }
    return <span>{value}</span>;
}

function formatVotePolicyFieldLabel(
    field: VotePolicyChange["field"],
    t: (key: string, values?: Record<string, any>) => string,
    roleName?: string,
): string {
    if (field === "threshold") {
        if (roleName) {
            return t("roleThreshold", { role: formatRoleName(roleName) });
        }
        return t("defaultThreshold");
    }
    const labels: Record<VotePolicyChange["field"], string> = {
        weight_kind: t("weightKind"),
        quorum: t("quorum"),
        threshold: t("threshold"),
    };
    return labels[field];
}

function formatThreshold(
    threshold: any,
    t: (key: string, values?: Record<string, any>) => string,
): React.ReactNode {
    if (isNullValue(threshold))
        return <span className="text-muted-foreground/50">null</span>;
    if (typeof threshold === "string") {
        const parsed = parseInt(threshold);
        if (!isNaN(parsed)) {
            return <span>{t("votesCount", { count: parsed })}</span>;
        }
        return <span>{threshold}</span>;
    }
    if (Array.isArray(threshold) && threshold.length === 2) {
        return <span>{t("votesCount", { count: threshold[0] })}</span>;
    }
    return <span>{JSON.stringify(threshold)}</span>;
}

function formatVotePolicyValue(
    field: VotePolicyChange["field"],
    value: any,
    t: (key: string, values?: Record<string, any>) => string,
): React.ReactNode {
    if (field === "threshold") {
        return formatThreshold(value, t);
    }
    return isNullValue(value) ? (
        <span className="text-muted-foreground/50">null</span>
    ) : (
        <span>{String(value)}</span>
    );
}

function PermissionPills({ roles }: { roles: string[] }) {
    return (
        <div className="flex flex-wrap justify-end gap-2">
            {roles.map((role) => (
                <Pill
                    key={role}
                    title={formatRoleName(role)}
                    className={PERMISSION_PILL_CLASS}
                />
            ))}
        </div>
    );
}

function getMemberRows(
    change: MemberRoleChange,
    type: "added" | "removed" | "updated",
    t: (key: string) => string,
): PolicyRow[] {
    const rows: PolicyRow[] = [
        {
            label: t("member"),
            value: <RequestParty accountId={change.member} />,
        },
    ];

    if (type === "added" && change.newRoles) {
        rows.push({
            label: t("permissions"),
            value: <PermissionPills roles={change.newRoles} />,
        });
    }

    if (type === "removed" && change.oldRoles) {
        rows.push({
            label: t("permissions"),
            value: <PermissionPills roles={change.oldRoles} />,
        });
    }

    if (type === "updated") {
        if (change.oldRoles) {
            rows.push({
                label: t("oldPermissions"),
                value: <PermissionPills roles={change.oldRoles} />,
            });
        }
        if (change.newRoles) {
            rows.push({
                label: t("newPermissions"),
                value: <PermissionPills roles={change.newRoles} />,
            });
        }
    }

    return rows;
}

function getCategoryLabel(
    type: "added" | "removed" | "updated",
    plural: boolean,
    t: (key: string) => string,
) {
    if (type === "added")
        return plural ? t("addNewMembers") : t("addNewMember");
    if (type === "removed")
        return plural ? t("removeMembers") : t("removeMember");
    return plural
        ? t("updateMembersPermissions")
        : t("updateMemberPermissions");
}

export function ChangePolicyExpanded({
    data,
    proposal,
}: ChangePolicyExpandedProps) {
    const t = useTranslations("changePolicyExpanded");
    const [expandedAdded, setExpandedAdded] = useState<number[]>([]);
    const [expandedRemoved, setExpandedRemoved] = useState<number[]>([]);
    const [expandedUpdated, setExpandedUpdated] = useState<number[]>([]);
    const { treasuryId } = useTreasury();
    const requestDisplayContext = useRequestDisplayContext()!;

    const isPending = requestDisplayContext.isPending;

    // If not pending, fetch the policy at the time of submission
    const { data: oldPolicy, isLoading: isLoadingTimestamped } =
        useTreasuryPolicy(
            treasuryId,
            !isPending ? proposal.submission_time : null,
        );

    const diff = useMemo(() => {
        if (!oldPolicy) return null;
        return computePolicyDiff(
            oldPolicy,
            data.newPolicy,
            data.originalProposalKind,
        );
    }, [oldPolicy, data.newPolicy, data.originalProposalKind]);

    if (isLoadingTimestamped) {
        return (
            <div className="flex items-center justify-center p-8">
                <Icon
                    icon={LoaderCircleIcon}
                    className="size-6 animate-spin text-muted-foreground"
                />
                <span className="ml-2 text-muted-foreground text-sm">
                    {t("loadingHistorical")}
                </span>
            </div>
        );
    }

    if (!diff) {
        return (
            <div className="p-4 text-center text-muted-foreground">
                {t("unableToDiff")}
            </div>
        );
    }

    const { policyChanges, roleChanges, defaultVotePolicyChanges } = diff;

    const hasNoChanges =
        policyChanges.length === 0 &&
        roleChanges.addedMembers.length === 0 &&
        roleChanges.removedMembers.length === 0 &&
        roleChanges.updatedMembers.length === 0 &&
        roleChanges.roleDefinitionChanges.length === 0 &&
        defaultVotePolicyChanges.length === 0;

    if (hasNoChanges) {
        return (
            <div className="flex flex-col gap-4">
                <div className="p-4 text-center text-muted-foreground">
                    {isPending
                        ? t("noChangesCurrent")
                        : t("noChangesHistorical")}
                </div>
                <TransactionDetails payload={data.originalProposalKind} />
            </div>
        );
    }

    /** The body, in the order the design reads it, ending in the payload. */
    const blocks: ReactNode[] = [];

    // 1. Policy parameter changes
    policyChanges.forEach((change) => {
        blocks.push(
            <DetailRow
                key={`policy-${change.field}`}
                label={formatFieldLabel(change.field, t)}
                value={renderDiff(
                    formatFieldValue(change.field, change.oldValue ?? "null"),
                    formatFieldValue(change.field, change.newValue ?? "null"),
                    isNullValue(change.oldValue),
                )}
            />,
        );
    });

    // 2. Default vote policy changes
    defaultVotePolicyChanges.forEach((change) => {
        blocks.push(
            <DetailRow
                key={`vote-policy-${change.field}`}
                label={formatVotePolicyFieldLabel(change.field, t)}
                value={renderDiff(
                    formatVotePolicyValue(change.field, change.oldValue, t),
                    formatVotePolicyValue(change.field, change.newValue, t),
                    isNullValue(change.oldValue),
                )}
            />,
        );
    });

    // 3. Member sections helper
    const addMemberSection = (
        changes: MemberRoleChange[],
        type: "added" | "removed" | "updated",
        expanded: number[],
        setExpanded: (val: number[] | ((prev: number[]) => number[])) => void,
    ) => {
        if (changes.length === 0) return;

        blocks.push(
            <DetailRow
                key={`category-${type}`}
                label={t("category")}
                value={getCategoryLabel(type, changes.length > 1, t)}
            />,
        );

        // A single member reads as plain rows; several are worth folding away
        // so the sheet doesn't turn into a wall of addresses.
        if (changes.length === 1) {
            getMemberRows(changes[0], type, t).forEach((row) => {
                blocks.push(
                    <DetailRow
                        key={`member-${type}-${row.label}`}
                        label={row.label}
                        value={row.value}
                    />,
                );
            });
            return;
        }

        const isAllExpanded = expanded.length === changes.length;

        blocks.push(
            <div key={`members-${type}`} className="flex flex-col gap-2">
                <DetailRow
                    label={t("members")}
                    value={
                        <div className="flex items-center justify-end gap-3">
                            <span>
                                {t("membersCount", { count: changes.length })}
                            </span>
                            <Button
                                variant="ghost"
                                onClick={() =>
                                    setExpanded(
                                        isAllExpanded
                                            ? []
                                            : changes.map((_, i) => i),
                                    )
                                }
                                className="h-7 rounded-sm px-2 text-xs text-general-unofficial-ghost-foreground"
                            >
                                {isAllExpanded
                                    ? t("collapseAll")
                                    : t("expandAll")}
                            </Button>
                        </div>
                    }
                />
                <div className="flex flex-col gap-2">
                    {changes.map((change, index) => (
                        <Collapsible
                            key={`${change.member}-${index}`}
                            open={expanded.includes(index)}
                            onOpenChange={() => {
                                setExpanded((prev) =>
                                    prev.includes(index)
                                        ? prev.filter((i) => i !== index)
                                        : [...prev, index],
                                );
                            }}
                            className="rounded-sm border border-general-border"
                        >
                            <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium">
                                <Icon
                                    icon={ArrowDown01Icon}
                                    className={cn(
                                        "size-4 shrink-0 transition-transform",
                                        expanded.includes(index) &&
                                            "rotate-180",
                                    )}
                                />
                                {t("memberIndex", { index: index + 1 })}
                            </CollapsibleTrigger>
                            <CollapsibleContent className="flex flex-col px-3 pb-1">
                                {getMemberRows(change, type, t).map((row) => (
                                    <DetailRow
                                        key={row.label}
                                        label={row.label}
                                        value={row.value}
                                    />
                                ))}
                            </CollapsibleContent>
                        </Collapsible>
                    ))}
                </div>
            </div>,
        );
    };

    addMemberSection(
        roleChanges.addedMembers,
        "added",
        expandedAdded,
        setExpandedAdded,
    );
    addMemberSection(
        roleChanges.updatedMembers,
        "updated",
        expandedUpdated,
        setExpandedUpdated,
    );
    addMemberSection(
        roleChanges.removedMembers,
        "removed",
        expandedRemoved,
        setExpandedRemoved,
    );

    // 4. Role Definition Changes
    const roleGroups = new Map<string, RoleDefinitionChange[]>();
    roleChanges.roleDefinitionChanges.forEach((change) => {
        const existing = roleGroups.get(change.roleName) || [];
        roleGroups.set(change.roleName, [...existing, change]);
    });

    Array.from(roleGroups.entries()).forEach(([roleName, changes]) => {
        const firstChange = changes[0];

        if (
            firstChange.oldThreshold !== undefined &&
            firstChange.newThreshold !== undefined &&
            JSON.stringify(firstChange.oldThreshold) !==
                JSON.stringify(firstChange.newThreshold)
        ) {
            blocks.push(
                <DetailRow
                    key={`role-threshold-${roleName}`}
                    label={formatVotePolicyFieldLabel("threshold", t, roleName)}
                    value={renderDiff(
                        formatVotePolicyValue(
                            "threshold",
                            firstChange.oldThreshold,
                            t,
                        ),
                        formatVotePolicyValue(
                            "threshold",
                            firstChange.newThreshold,
                            t,
                        ),
                        isNullValue(firstChange.oldThreshold),
                    )}
                />,
            );
        }

        if (firstChange.oldQuorum !== firstChange.newQuorum) {
            blocks.push(
                <DetailRow
                    key={`role-quorum-${roleName}`}
                    label={t("quorum")}
                    value={renderDiff(
                        formatVotePolicyValue(
                            "quorum",
                            firstChange.oldQuorum,
                            t,
                        ),
                        formatVotePolicyValue(
                            "quorum",
                            firstChange.newQuorum,
                            t,
                        ),
                        isNullValue(firstChange.oldQuorum),
                    )}
                />,
            );
        }

        if (firstChange.oldWeightKind !== firstChange.newWeightKind) {
            blocks.push(
                <DetailRow
                    key={`role-weight-${roleName}`}
                    label={t("weightKind")}
                    value={renderDiff(
                        formatVotePolicyValue(
                            "weight_kind",
                            firstChange.oldWeightKind,
                            t,
                        ),
                        formatVotePolicyValue(
                            "weight_kind",
                            firstChange.newWeightKind,
                            t,
                        ),
                        isNullValue(firstChange.oldWeightKind),
                    )}
                />,
            );
        }

        if (
            firstChange.oldPermissions &&
            firstChange.newPermissions &&
            JSON.stringify([...firstChange.oldPermissions].sort()) !==
                JSON.stringify([...firstChange.newPermissions].sort())
        ) {
            blocks.push(
                <DetailRow
                    key={`role-permissions-${roleName}`}
                    label={t("permissions")}
                    align="start"
                    value={renderDiff(
                        <div className="flex flex-wrap justify-end gap-2">
                            {firstChange.oldPermissions.map((permission) => (
                                <Pill
                                    key={permission}
                                    title={permission}
                                    className={PERMISSION_PILL_CLASS}
                                />
                            ))}
                        </div>,
                        <div className="flex flex-wrap justify-end gap-2">
                            {firstChange.newPermissions.map((permission) => (
                                <Pill
                                    key={permission}
                                    title={permission}
                                    className={PERMISSION_PILL_CLASS}
                                />
                            ))}
                        </div>,
                        isNullValue(firstChange.oldPermissions),
                    )}
                />,
            );
        }
    });

    return (
        <div className="flex flex-col">
            {blocks}
            <TransactionDetails payload={data.originalProposalKind} />
        </div>
    );
}

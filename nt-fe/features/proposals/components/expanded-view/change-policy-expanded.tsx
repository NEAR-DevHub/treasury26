"use client";

import { useTranslations } from "next-intl";
import {
    ChangePolicyData,
    PolicyChange,
    MemberRoleChange,
    VotePolicyChange,
    RoleDefinitionChange,
} from "../../types/index";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Amount } from "../amount";
import { formatNanosecondDuration } from "@/lib/utils";
import { User } from "@/components/user";
import { useState, useMemo } from "react";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/pill";
import { Button } from "@/components/button";
import { renderDiff, isNullValue } from "../../utils/diff-utils";
import { formatRoleName, useFormatRoleName } from "@/components/role-name";
import { Proposal } from "@/lib/proposals-api";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { computePolicyDiff } from "../../utils/policy-diff-utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useRequestDisplayContext } from "./common/request-display-context";

interface ChangePolicyExpandedProps {
    data: ChangePolicyData;
    proposal: Proposal;
}

function formatFieldLabel(
    field: PolicyChange["field"],
    t: (key: string) => string,
): string {
    const labels: Record<PolicyChange["field"], string> = {
        proposal_bond: t("proposalBond"),
        proposal_period: t("proposalPeriod"),
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

function getMemberItems(
    change: MemberRoleChange,
    type: "added" | "removed" | "updated",
    t: (key: string) => string,
): InfoItem[] {
    const items: InfoItem[] = [
        {
            label: t("member"),
            value: <User accountId={change.member} />,
        },
    ];

    if (type === "added" && change.newRoles) {
        items.push({
            label: t("permissions"),
            value: (
                <div className="flex flex-wrap gap-1">
                    {change.newRoles.map((role) => (
                        <Pill
                            key={role}
                            title={formatRoleName(role)}
                            variant="secondary"
                        />
                    ))}
                </div>
            ),
        });
    }

    if (type === "removed" && change.oldRoles) {
        items.push({
            label: t("permissions"),
            value: (
                <div className="flex flex-wrap gap-1">
                    {change.oldRoles.map((role) => (
                        <Pill
                            key={role}
                            title={formatRoleName(role)}
                            variant="card"
                        />
                    ))}
                </div>
            ),
        });
    }

    if (type === "updated") {
        if (change.oldRoles) {
            items.push({
                label: t("oldPermissions"),
                value: (
                    <div className="flex flex-wrap gap-1">
                        {change.oldRoles.map((role) => (
                            <Pill
                                key={role}
                                title={formatRoleName(role)}
                                variant="card"
                            />
                        ))}
                    </div>
                ),
            });
        }
        if (change.newRoles) {
            items.push({
                label: t("newPermissions"),
                value: (
                    <div className="flex flex-wrap gap-1">
                        {change.newRoles.map((role) => (
                            <Pill
                                key={role}
                                title={formatRoleName(role)}
                                variant="card"
                            />
                        ))}
                    </div>
                ),
            });
        }
    }

    return items;
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
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
                <InfoDisplay
                    items={[
                        {
                            label: t("transactionDetails"),
                            value: null,
                            afterValue: (
                                <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
                                    <code className="text-foreground/90">
                                        {JSON.stringify(
                                            data.originalProposalKind,
                                            null,
                                            2,
                                        )}
                                    </code>
                                </pre>
                            ),
                        },
                    ]}
                />
            </div>
        );
    }

    const allItems: InfoItem[] = [];

    // 1. Policy parameter changes
    policyChanges.forEach((change) => {
        const isOldNull = isNullValue(change.oldValue);
        allItems.push({
            label: formatFieldLabel(change.field, t),
            value: renderDiff(
                formatFieldValue(change.field, change.oldValue ?? "null"),
                formatFieldValue(change.field, change.newValue ?? "null"),
                isOldNull,
            ),
        });
    });

    // 2. Default vote policy changes
    defaultVotePolicyChanges.forEach((change) => {
        const isOldNull = isNullValue(change.oldValue);
        allItems.push({
            label: formatVotePolicyFieldLabel(change.field, t),
            value: renderDiff(
                formatVotePolicyValue(change.field, change.oldValue, t),
                formatVotePolicyValue(change.field, change.newValue, t),
                isOldNull,
            ),
        });
    });

    // 3. Member sections helper
    const addMemberSection = (
        changes: MemberRoleChange[],
        type: "added" | "removed" | "updated",
        expanded: number[],
        setExpanded: (val: number[] | ((prev: number[]) => number[])) => void,
    ) => {
        if (changes.length === 0) return;

        if (changes.length === 1) {
            allItems.push({
                label: t("category"),
                value: <span>{getCategoryLabel(type, false, t)}</span>,
            });
            allItems.push(...getMemberItems(changes[0], type, t));
        } else {
            const isAllExpanded = expanded.length === changes.length;
            const toggleAll = () => {
                if (isAllExpanded) setExpanded([]);
                else setExpanded(changes.map((_, i) => i));
            };

            allItems.push({
                label: t("category"),
                value: <span>{getCategoryLabel(type, true, t)}</span>,
            });

            allItems.push({
                label: t("members"),
                value: (
                    <div className="flex gap-3 items-baseline">
                        <p className="text-sm font-medium">
                            {t("membersCount", { count: changes.length })}
                        </p>
                        <Button variant="ghost" size="sm" onClick={toggleAll}>
                            {isAllExpanded ? t("collapseAll") : t("expandAll")}
                        </Button>
                    </div>
                ),
                afterValue: (
                    <div className="flex flex-col gap-1">
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
                            >
                                <CollapsibleTrigger
                                    className={cn(
                                        "w-full flex justify-between items-center p-3 border rounded-lg",
                                        expanded.includes(index) &&
                                            "rounded-b-none",
                                    )}
                                >
                                    <div className="flex gap-2 items-center">
                                        <ChevronDown
                                            className={cn(
                                                "w-4 h-4",
                                                expanded.includes(index) &&
                                                    "rotate-180",
                                            )}
                                        />
                                        {t("memberIndex", {
                                            index: index + 1,
                                        })}
                                    </div>
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                    <InfoDisplay
                                        style="secondary"
                                        className="p-3 rounded-b-lg"
                                        items={getMemberItems(change, type, t)}
                                    />
                                </CollapsibleContent>
                            </Collapsible>
                        ))}
                    </div>
                ),
            });
        }
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
            const isOldNull = isNullValue(firstChange.oldThreshold);
            allItems.push({
                label: formatVotePolicyFieldLabel("threshold", t, roleName),
                value: renderDiff(
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
                    isOldNull,
                ),
            });
        }

        if (firstChange.oldQuorum !== firstChange.newQuorum) {
            const isOldNull = isNullValue(firstChange.oldQuorum);
            allItems.push({
                label: t("quorum"),
                value: renderDiff(
                    formatVotePolicyValue("quorum", firstChange.oldQuorum, t),
                    formatVotePolicyValue("quorum", firstChange.newQuorum, t),
                    isOldNull,
                ),
            });
        }

        if (firstChange.oldWeightKind !== firstChange.newWeightKind) {
            const isOldNull = isNullValue(firstChange.oldWeightKind);
            allItems.push({
                label: t("weightKind"),
                value: renderDiff(
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
                    isOldNull,
                ),
            });
        }

        if (
            firstChange.oldPermissions &&
            firstChange.newPermissions &&
            JSON.stringify([...firstChange.oldPermissions].sort()) !==
                JSON.stringify([...firstChange.newPermissions].sort())
        ) {
            const isOldNull = isNullValue(firstChange.oldPermissions);
            allItems.push({
                label: t("permissions"),
                value: renderDiff(
                    <div className="flex flex-wrap gap-1">
                        {firstChange.oldPermissions?.map((permission) => (
                            <Pill
                                key={permission}
                                title={permission}
                                variant="card"
                            />
                        )) || (
                            <span className="text-muted-foreground/50">
                                null
                            </span>
                        )}
                    </div>,
                    <div className="flex flex-wrap gap-1">
                        {firstChange.newPermissions.map((permission) => (
                            <Pill
                                key={permission}
                                title={permission}
                                variant="card"
                            />
                        ))}
                    </div>,
                    isOldNull,
                ),
            });
        }
    });

    // 5. Transaction Details
    allItems.push({
        label: t("transactionDetails"),
        value: null,
        afterValue: (
            <ScrollArea className="flex h-96 w-full">
                {" "}
                <pre className="overflow-x-auto w-full rounded-md bg-muted/50 p-3 text-xs">
                    <code className="text-foreground/90 w-full">
                        {JSON.stringify(data.originalProposalKind, null, 2)}
                    </code>
                </pre>
            </ScrollArea>
        ),
    });

    return <InfoDisplay items={allItems} />;
}

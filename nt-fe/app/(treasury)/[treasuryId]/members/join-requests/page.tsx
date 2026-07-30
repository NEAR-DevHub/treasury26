"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormProvider, useForm, useFormContext } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { Button } from "@/components/button";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { PageCard } from "@/components/card";
import { InputBlock } from "@/components/input-block";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useFormatRoleName } from "@/components/role-name";
import { RoleSelector } from "@/components/role-selector";
import {
    StepperHeader,
    StepWizard,
    type StepProps,
} from "@/components/step-wizard";
import { FormField, FormMessage } from "@/components/ui/form";
import { User } from "@/components/user";
import {
    useApproveMemberJoinRequests,
    useCancelMemberJoinRequest,
    useMemberJoinRequests,
} from "@/hooks/use-member-invites";
import { useTreasury } from "@/hooks/use-treasury";
import { reportError } from "@/lib/report-error";
import { sortRolesByOrder } from "@/lib/role-utils";
import { useRoleDescription } from "@/lib/use-role-description";
import { encodeToMarkdown } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import type { MemberFormData } from "../components/member-form-step";
import { MemberReviewStep } from "../components/member-review-step";
import { useDisabledMemberRoles } from "../hooks/use-disabled-member-roles";
import { useMemberPolicyGate } from "../hooks/use-member-policy-gate";
import { applyMemberRolesToPolicy } from "../utils/policy-helpers";

type AssignStepProps = StepProps & {
    onExit: () => void;
    availableRoles: Array<{
        id: string;
        title: string;
        description?: string;
    }>;
    requestIds: string[];
    onRemove: (requestId: string) => void;
    isRemoving: boolean;
    reviewDisabledReason?: string;
    getDisabledRoles?: (
        accountId: string,
        currentRoles: string[],
    ) => { roleId: string; reason: string }[];
};

function JoinRequestsAssignStep({
    handleNext,
    onExit,
    availableRoles,
    requestIds,
    onRemove,
    isRemoving,
    reviewDisabledReason,
    getDisabledRoles,
}: AssignStepProps) {
    const t = useTranslations("members.joinRequests");
    const tModal = useTranslations("members.memberModal");
    const form = useFormContext<MemberFormData>();
    const members = form.watch("members");
    const allHaveRoles =
        members.length > 0 && members.every((m) => m.roles.length > 0);
    const canReview = allHaveRoles && !reviewDisabledReason;

    return (
        <PageCard className="gap-4">
            <StepperHeader title={t("title")} handleBack={onExit} />
            <InputBlock invalid={false} className="p-0">
                <div className="flex flex-col">
                    {members.map((member, index) => (
                        <div
                            key={requestIds[index] ?? member.accountId}
                            className="flex px-3.5 first:rounded-t-xl first:pt-3 not-first:pt-2 last:pb-3 flex-col gap-0 border-b border-muted-foreground/10 last:border-b-0"
                        >
                            <div className="flex justify-between items-center">
                                <p className="text-xs text-muted-foreground">
                                    {t("memberAddress")}
                                </p>
                                <Button
                                    variant="ghost"
                                    className="size-6 p-0! group hover:text-destructive"
                                    disabled={isRemoving}
                                    onClick={() => {
                                        const id = requestIds[index];
                                        if (id) onRemove(id);
                                    }}
                                >
                                    <Trash2 className="size-4 text-foreground group-hover:text-destructive" />
                                </Button>
                            </div>
                            <div className="flex md:flex-row flex-col items-start justify-between md:items-center gap-3">
                                <div className="flex-1 min-w-0">
                                    <User
                                        accountId={member.accountId}
                                        size="md"
                                        variant="details"
                                        withLink={false}
                                        withHoverCard
                                    />
                                </div>
                                <FormField
                                    control={form.control}
                                    name={`members.${index}.roles`}
                                    render={({ field }) => (
                                        <RoleSelector
                                            selectedRoles={field.value}
                                            onRolesChange={field.onChange}
                                            availableRoles={availableRoles}
                                            disabledRoles={
                                                getDisabledRoles
                                                    ? getDisabledRoles(
                                                          member.accountId,
                                                          field.value || [],
                                                      )
                                                    : []
                                            }
                                        />
                                    )}
                                />
                            </div>
                            <FormField
                                control={form.control}
                                name={`members.${index}.roles`}
                                render={({ fieldState }) =>
                                    fieldState.error ? (
                                        <FormMessage className="text-sm mb-2" />
                                    ) : (
                                        <p className="text-xs invisible">.</p>
                                    )
                                }
                            />
                        </div>
                    ))}
                </div>
            </InputBlock>
            <ButtonWithTooltip
                type="button"
                className="w-full"
                disabled={!canReview}
                tooltipMessage={
                    reviewDisabledReason ||
                    (members.length === 0
                        ? t("empty")
                        : !allHaveRoles
                          ? t("setRolesRequired")
                          : undefined)
                }
                onClick={async () => {
                    if (reviewDisabledReason) return;
                    const valid = await form.trigger();
                    if (valid) handleNext?.();
                }}
            >
                {tModal("reviewRequest")}
            </ButtonWithTooltip>
        </PageCard>
    );
}

export default function JoinRequestsPage() {
    const t = useTranslations("pages.members");
    const tMembers = useTranslations("members");
    const tJoin = useTranslations("members.joinRequests");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { createProposal } = useNear();
    const {
        policy,
        isLoading,
        existingMembers,
        hasPendingMemberRequest,
        canAddMember,
        availableRoles,
    } = useMemberPolicyGate(treasuryId);
    const { data: joinRequests = [], isLoading: isLoadingRequests } =
        useMemberJoinRequests(treasuryId);
    const cancelRequest = useCancelMemberJoinRequest(treasuryId);
    const approveRequests = useApproveMemberJoinRequests(treasuryId);
    const formatRoleName = useFormatRoleName();
    const getRoleDescription = useRoleDescription();

    const [step, setStep] = useState(0);
    const [requestIds, setRequestIds] = useState<string[]>([]);

    const reviewDisabledReason = hasPendingMemberRequest
        ? tJoin("pendingPolicyRequest")
        : undefined;

    // Keep this page reachable while a ChangePolicy is pending so users can
    // view/remove join requests; only block submitting a new add-members proposal.
    useEffect(() => {
        if (!isLoading && !canAddMember && treasuryId) {
            router.replace(`/${treasuryId}/members`);
        }
    }, [isLoading, canAddMember, router, treasuryId]);

    const schema = useMemo(
        () =>
            z.object({
                members: z
                    .array(
                        z.object({
                            accountId: z.string().min(1),
                            roles: z
                                .array(z.string())
                                .min(1, tMembers("validation.atLeastOneRole")),
                        }),
                    )
                    .min(1, tJoin("empty")),
            }),
        [tMembers, tJoin],
    );

    const form = useForm<MemberFormData>({
        resolver: zodResolver(schema),
        mode: "onChange",
        defaultValues: { members: [] },
    });

    useEffect(() => {
        if (isLoadingRequests) return;

        const rolesByAccount = new Map(
            form.getValues("members").map((m) => [m.accountId, m.roles]),
        );

        setRequestIds(joinRequests.map((r) => r.id));
        form.reset({
            members: joinRequests.map((req) => ({
                accountId: req.accountId,
                roles: rolesByAccount.get(req.accountId) ?? [],
            })),
        });
        // Only re-sync when the server list changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [joinRequests, isLoadingRequests]);

    const mappedRoles = useMemo(() => {
        const mapped = availableRoles.map((r) => ({
            id: r.name,
            title: formatRoleName(r.name),
            description: getRoleDescription(r.name),
        }));
        const sortedNames = sortRolesByOrder(mapped.map((r) => r.id));
        return sortedNames.map((name) => mapped.find((r) => r.id === name)!);
    }, [availableRoles, formatRoleName, getRoleDescription]);

    const exitToMembers = useCallback(() => {
        router.push(`/${treasuryId}/members`);
    }, [router, treasuryId]);

    const membersInForm = form.watch("members") || [];
    const getDisabledRoles = useDisabledMemberRoles(
        membersInForm,
        existingMembers,
        availableRoles,
    );

    const handleRemove = useCallback(
        async (requestId: string) => {
            try {
                const index = requestIds.indexOf(requestId);
                await cancelRequest.mutateAsync(requestId);
                const nextIds = requestIds.filter((id) => id !== requestId);
                const nextMembers = form
                    .getValues("members")
                    .filter((_, i) => i !== index);
                setRequestIds(nextIds);
                form.setValue("members", nextMembers);
                if (nextIds.length === 0) {
                    router.push(`/${treasuryId}/members`);
                }
            } catch (error) {
                reportError(error, "Failed to remove join request");
                toast.error(tJoin("removeFailed"));
            }
        },
        [cancelRequest, form, requestIds, router, treasuryId, tJoin],
    );

    const handleSubmit = useCallback(async () => {
        if (!policy || !treasuryId || hasPendingMemberRequest) return;

        const data = form.getValues();
        const membersList = data.members.map(({ accountId, roles }) => ({
            member: accountId,
            roles,
        }));

        const { updatedPolicy, summary } = applyMemberRolesToPolicy(
            policy,
            membersList,
            existingMembers,
            false,
        );

        if (!updatedPolicy) return;

        try {
            await createProposal(tMembers("policy.addMembersSuccess"), {
                treasuryId,
                proposalBond: policy.proposal_bond || "0",
                proposal: {
                    description: encodeToMarkdown({
                        title: tMembers("policy.addMembers"),
                        summary,
                    }),
                    kind: {
                        ChangePolicy: {
                            policy: updatedPolicy,
                        },
                    },
                },
                proposalType: "other",
            });
        } catch (error) {
            // Wallet rejected / proposal failed — stay on review to retry.
            reportError(error, "Failed to create add-members proposal");
            toast.error(tMembers("policy.createProposalFailed"));
            return;
        }

        // Proposal is on-chain. Always leave this page afterward so a failed
        // approve cannot leave the same requests open for a duplicate submit.
        try {
            await approveRequests.mutateAsync(requestIds);
        } catch (error) {
            // Proposal already succeeded; leave the page so retry can't
            // create a second ChangePolicy for the same accounts.
            // Non-blocking for the user — still report for observability.
            reportError(error, "Failed to mark join requests approved");
        }

        queryClient.invalidateQueries({
            queryKey: ["proposals", treasuryId],
        });
        queryClient.invalidateQueries({
            queryKey: ["member-join-requests", treasuryId],
        });

        router.push(`/${treasuryId}/members`);
    }, [
        policy,
        treasuryId,
        hasPendingMemberRequest,
        form,
        existingMembers,
        createProposal,
        tMembers,
        approveRequests,
        requestIds,
        queryClient,
        router,
    ]);

    const steps = useMemo(
        () => [
            {
                component: JoinRequestsAssignStep,
                props: {
                    onExit: exitToMembers,
                    availableRoles: mappedRoles,
                    requestIds,
                    onRemove: handleRemove,
                    isRemoving: cancelRequest.isPending,
                    reviewDisabledReason,
                    getDisabledRoles,
                },
            },
            {
                component: MemberReviewStep,
                props: {
                    onSubmit: handleSubmit,
                    mode: "add" as const,
                    showJoinProfiles: true,
                    validationError: reviewDisabledReason,
                },
            },
        ],
        [
            exitToMembers,
            mappedRoles,
            requestIds,
            handleRemove,
            cancelRequest.isPending,
            reviewDisabledReason,
            getDisabledRoles,
            handleSubmit,
        ],
    );

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <div className="max-w-xl mx-auto w-full">
                <FormProvider {...form}>
                    {isLoading || isLoadingRequests ? (
                        <PageCard>
                            <div className="h-40 animate-pulse bg-muted rounded-lg" />
                        </PageCard>
                    ) : joinRequests.length === 0 && step === 0 ? (
                        <PageCard className="gap-4">
                            <StepperHeader
                                title={tJoin("title")}
                                handleBack={exitToMembers}
                            />
                            <p className="text-sm text-muted-foreground">
                                {tJoin("empty")}
                            </p>
                        </PageCard>
                    ) : (
                        <StepWizard
                            step={step}
                            onStepChange={setStep}
                            steps={steps}
                        />
                    )}
                </FormProvider>
            </div>
        </PageComponentLayout>
    );
}

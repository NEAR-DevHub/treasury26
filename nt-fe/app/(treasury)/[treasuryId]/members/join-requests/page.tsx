"use client";

import { Icon } from "@/components/icon";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    FormProvider,
    useFieldArray,
    useForm,
    useFormContext,
} from "react-hook-form";
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
import type { MemberJoinRequest } from "@/lib/member-invites-api";
import { reportError } from "@/lib/report-error";
import { sortRolesByOrder } from "@/lib/role-utils";
import { useRoleDescription } from "@/lib/use-role-description";
import { encodeToMarkdown } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { MemberReviewStep } from "../components/member-review-step";
import { useDisabledMemberRoles } from "../hooks/use-disabled-member-roles";
import { useMemberPolicyGate } from "../hooks/use-member-policy-gate";
import { applyMemberRolesToPolicy } from "../utils/policy-helpers";

type JoinRequestFormData = {
    members: Array<{
        requestId: string;
        accountId: string;
        roles: string[];
    }>;
};

function requestIdsKey(
    items: Array<{ id?: string; requestId?: string }>,
): string {
    return items.map((item) => item.id ?? item.requestId ?? "").join("\0");
}

type AssignStepProps = StepProps & {
    onExit: () => void;
    availableRoles: Array<{
        id: string;
        title: string;
        description?: string;
    }>;
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
    onRemove,
    isRemoving,
    reviewDisabledReason,
    getDisabledRoles,
}: AssignStepProps) {
    const t = useTranslations("members.joinRequests");
    const tModal = useTranslations("members.memberModal");
    const form = useFormContext<JoinRequestFormData>();
    const members = form.watch("members") ?? [];
    const allHaveRoles =
        members.length > 0 && members.every((m) => (m?.roles?.length ?? 0) > 0);
    const canReview = allHaveRoles && !reviewDisabledReason;

    return (
        <PageCard className="gap-4">
            <StepperHeader title={t("title")} handleBack={onExit} />
            <InputBlock invalid={false} className="p-0">
                <div className="flex flex-col">
                    {members.map((member, index) => (
                        <div
                            key={member.requestId}
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
                                    onClick={() => onRemove(member.requestId)}
                                >
                                    <Icon
                                        icon={Delete02Icon}
                                        className="text-foreground group-hover:text-destructive"
                                    />
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
                                            selectedRoles={field.value ?? []}
                                            onRolesChange={field.onChange}
                                            availableRoles={availableRoles}
                                            disabledRoles={
                                                getDisabledRoles
                                                    ? getDisabledRoles(
                                                          member.accountId,
                                                          field.value ?? [],
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
    const [isSubmittingRequest, setIsSubmittingRequest] = useState(false);

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
                            requestId: z.string().min(1),
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

    const form = useForm<JoinRequestFormData>({
        resolver: zodResolver(schema),
        mode: "onChange",
        defaultValues: { members: [] },
    });
    const { remove } = useFieldArray({
        control: form.control,
        name: "members",
    });

    // Sync who is pending from the server. Skip when already aligned, on the
    // review step, or while submitting so assigned roles are not clobbered.
    useEffect(() => {
        if (isLoadingRequests || isSubmittingRequest || step > 0) return;

        const current = form.getValues("members") ?? [];
        if (requestIdsKey(joinRequests) === requestIdsKey(current)) return;

        const rolesByAccount = new Map(
            current
                .filter((m) => m?.accountId)
                .map((m) => [m.accountId, m.roles ?? []]),
        );

        form.reset({
            members: joinRequests.map((req) => ({
                requestId: req.id,
                accountId: req.accountId,
                roles: rolesByAccount.get(req.accountId) ?? [],
            })),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [joinRequests, isLoadingRequests, isSubmittingRequest, step]);

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
            const members = form.getValues("members");
            const index = members.findIndex((m) => m.requestId === requestId);
            if (index < 0) return;

            const previousRequests = queryClient.getQueryData<
                MemberJoinRequest[]
            >(["member-join-requests", treasuryId]);
            const previousMembers = members;

            remove(index);
            queryClient.setQueryData<MemberJoinRequest[]>(
                ["member-join-requests", treasuryId],
                (old) => (old ?? []).filter((r) => r.id !== requestId),
            );

            try {
                await cancelRequest.mutateAsync(requestId);
                if (previousMembers.length <= 1) {
                    router.push(`/${treasuryId}/members`);
                }
            } catch (error) {
                form.reset({ members: previousMembers });
                queryClient.setQueryData(
                    ["member-join-requests", treasuryId],
                    previousRequests,
                );
                reportError(error, "Failed to remove join request");
                toast.error(tJoin("removeFailed"));
            }
        },
        [cancelRequest, form, queryClient, remove, router, treasuryId, tJoin],
    );

    const handleSubmit = useCallback(async () => {
        if (!policy || !treasuryId || hasPendingMemberRequest) return;

        const members = form.getValues("members");
        const membersList = members.map(({ accountId, roles }) => ({
            member: accountId,
            roles: roles ?? [],
        }));
        const requestIds = members.map((m) => m.requestId);

        const { updatedPolicy, summary } = applyMemberRolesToPolicy(
            policy,
            membersList,
            existingMembers,
            false,
        );

        if (!updatedPolicy) return;

        setIsSubmittingRequest(true);
        try {
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
                // createProposal already toasts wallet rejection — stay on review.
                reportError(error, "Failed to create add-members proposal");
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
        } finally {
            setIsSubmittingRequest(false);
        }
    }, [
        policy,
        treasuryId,
        hasPendingMemberRequest,
        form,
        existingMembers,
        createProposal,
        tMembers,
        approveRequests,
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
                            <div className="h-40 animate-pulse bg-general-unofficial-accent-0 rounded-lg" />
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

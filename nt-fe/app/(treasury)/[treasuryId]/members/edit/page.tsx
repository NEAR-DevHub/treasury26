"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import * as z from "zod";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepWizard } from "@/components/step-wizard";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryMembers } from "@/hooks/use-treasury-members";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import { encodeToMarkdown } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import {
    MemberFormStep,
    type MemberFormData,
} from "../components/member-form-step";
import { MemberReviewStep } from "../components/member-review-step";
import { getDisabledRolesForMemberEdit } from "../utils/disabled-roles";
import { applyMemberRolesToPolicy } from "../utils/policy-helpers";

export default function EditMemberPage() {
    const t = useTranslations("pages.members");
    const tMembers = useTranslations("members");
    const tMemberValidation = useTranslations("memberValidation");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const { createProposal } = useNear();
    const { data: policy, isLoading: isLoadingPolicy } = useTreasuryPolicy(
        treasuryId || "",
    );
    const { members: existingMembers, isLoading: isLoadingMembers } =
        useTreasuryMembers(treasuryId);
    const isLoading = isLoadingPolicy || isLoadingMembers;

    const [step, setStep] = useState(0);
    const hasSeededMembers = useRef(false);

    const { data: pendingProposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        proposal_types: ["ChangePolicy", "ChangePolicyUpdateParameters"],
        sort_direction: "desc",
        sort_by: "CreationTime",
    });

    const hasPendingMemberRequest = useMemo(() => {
        if (!pendingProposals?.proposals) return false;
        return pendingProposals.proposals.length > 0;
    }, [pendingProposals]);

    const isMemberDataReady = !isLoading && pendingProposals !== undefined;
    const isMemberActionsDisabled =
        !isMemberDataReady || hasPendingMemberRequest;

    const availableRoles = useMemo(() => {
        if (!policy?.roles) return [];
        return policy.roles.filter(
            (role) =>
                typeof role.kind === "object" &&
                "Group" in role.kind &&
                role.name.toLowerCase() !== "all",
        );
    }, [policy]);

    const memberIdsFromUrl = useMemo(() => {
        const raw = searchParams.get("members") || "";
        return raw
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
    }, [searchParams]);

    const originalMembers = useMemo(() => {
        return memberIdsFromUrl
            .map((accountIdValue) => {
                const member = existingMembers.find(
                    (m) =>
                        m.accountId.toLowerCase() ===
                        accountIdValue.toLowerCase(),
                );
                return member
                    ? { accountId: member.accountId, roles: member.roles }
                    : null;
            })
            .filter(
                (m): m is { accountId: string; roles: string[] } => m !== null,
            );
    }, [memberIdsFromUrl, existingMembers]);

    const editMemberSchema = useMemo(
        () =>
            z.object({
                members: z
                    .array(
                        z.object({
                            accountId: z
                                .string()
                                .min(
                                    1,
                                    tMembers("validation.accountIdRequired"),
                                ),
                            roles: z
                                .array(z.string())
                                .min(1, tMembers("validation.atLeastOneRole")),
                        }),
                    )
                    .min(1, tMembers("validation.atLeastOneMember")),
            }),
        [tMembers],
    );

    const form = useForm<MemberFormData>({
        resolver: zodResolver(editMemberSchema),
        mode: "onChange",
        defaultValues: {
            members: [],
        },
    });

    // Only bounce away if a pending ChangePolicy already exists when the page
    // first becomes ready. Do not redirect when pending flips mid-submit.
    const didCheckInitialPending = useRef(false);
    useEffect(() => {
        if (!isMemberDataReady || didCheckInitialPending.current) return;
        didCheckInitialPending.current = true;
        if (hasPendingMemberRequest && treasuryId) {
            router.replace(`/${treasuryId}/members`);
        }
    }, [isMemberDataReady, hasPendingMemberRequest, router, treasuryId]);

    // Wait until policy/members are actually loaded (not merely "not loading" —
    // a disabled query is also not loading and would otherwise bounce immediately).
    const membersReady = !isLoadingMembers && !isLoadingPolicy && !!policy;

    useEffect(() => {
        if (!treasuryId || !membersReady) return;
        if (memberIdsFromUrl.length === 0 || originalMembers.length === 0) {
            router.replace(`/${treasuryId}/members`);
        }
    }, [
        treasuryId,
        membersReady,
        memberIdsFromUrl.length,
        originalMembers.length,
        router,
    ]);

    // Seed as soon as URL members resolve — do not wait on pending-proposal
    // readiness or the form stays empty while the wizard is already visible.
    useEffect(() => {
        if (hasSeededMembers.current || originalMembers.length === 0) return;

        hasSeededMembers.current = true;
        form.reset({
            members: originalMembers.map((m) => ({
                accountId: m.accountId,
                roles: [...m.roles],
            })),
        });
    }, [originalMembers, form]);

    const exitToMembers = useCallback(() => {
        router.push(`/${treasuryId}/members`);
    }, [router, treasuryId]);

    const membersInForm = form.watch("members") || [];

    const getDisabledRoles = useCallback(
        (memberAccountId: string, currentRoles: string[]) =>
            getDisabledRolesForMemberEdit(
                memberAccountId,
                currentRoles,
                membersInForm,
                existingMembers,
                availableRoles,
                {
                    requestorOnlyTooltip: tMembers("requestorOnlyTooltip"),
                    cannotRemoveRoleAfter: (role) =>
                        tMembers("validation.cannotRemoveRoleAfter", { role }),
                    cannotRemoveRoleAfterGov: (role) =>
                        tMembers("validation.cannotRemoveRoleAfterGov", {
                            role,
                        }),
                },
            ),
        [membersInForm, existingMembers, availableRoles, tMembers],
    );

    const handleReviewRequest = useCallback(async () => {
        const isValid = await form.trigger();
        if (!isValid) return;

        trackEvent("member-edit-review-clicked", { treasury_id: treasuryId });
        setStep(1);
    }, [form, treasuryId]);

    const handleSubmit = useCallback(async () => {
        if (!policy || !treasuryId || isMemberActionsDisabled) return;

        const data = form.getValues();
        const membersList = data.members.map(({ accountId, roles }) => ({
            member: accountId,
            roles,
        }));

        const { updatedPolicy, summary } = applyMemberRolesToPolicy(
            policy,
            membersList,
            existingMembers,
            true,
        );

        if (!updatedPolicy) return;

        const title =
            data.members.length === 1
                ? tMembers("policy.editMember")
                : tMembers("policy.editMembers");
        const successMessage =
            data.members.length === 1
                ? tMembers("policy.editMemberSuccess")
                : tMembers("policy.editMembersSuccess");

        try {
            await createProposal(successMessage, {
                treasuryId,
                proposalBond: policy.proposal_bond || "0",
                proposal: {
                    description: encodeToMarkdown({
                        title,
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

            trackEvent("member-edit-submitted", {
                treasury_id: treasuryId,
                members_count: data.members.length,
            });

            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });

            router.push(`/${treasuryId}/members`);
        } catch (error) {
            console.error("Failed to edit members:", error);
        }
    }, [
        policy,
        treasuryId,
        isMemberActionsDisabled,
        form,
        existingMembers,
        createProposal,
        tMembers,
        queryClient,
        router,
    ]);

    const steps = useMemo(
        () => [
            {
                component: MemberFormStep,
                props: {
                    availableRoles,
                    isValidatingAddresses: false,
                    mode: "edit" as const,
                    originalMembers,
                    getDisabledRoles,
                    validationError: hasPendingMemberRequest
                        ? tMemberValidation("pendingRequest")
                        : undefined,
                    onReviewRequest: handleReviewRequest,
                    onExit: exitToMembers,
                },
            },
            {
                component: MemberReviewStep,
                props: {
                    onSubmit: handleSubmit,
                    mode: "edit" as const,
                    existingMembers,
                },
            },
        ],
        [
            availableRoles,
            originalMembers,
            getDisabledRoles,
            hasPendingMemberRequest,
            tMemberValidation,
            handleReviewRequest,
            exitToMembers,
            handleSubmit,
            existingMembers,
        ],
    );

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <div className="max-w-xl mx-auto w-full">
                <FormProvider {...form}>
                    {!membersReady || originalMembers.length === 0 ? (
                        <PageCard>
                            <div className="h-40 animate-pulse bg-muted rounded-lg" />
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

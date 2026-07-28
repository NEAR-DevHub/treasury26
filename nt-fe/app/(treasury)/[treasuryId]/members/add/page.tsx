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
import {
    isValidNearAddressFormat,
    validateNearAddress,
} from "@/lib/near-validation";
import { translateNearValidationError } from "@/lib/near-validation-i18n";
import { hasPermission } from "@/lib/config-utils";
import { encodeToMarkdown } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import {
    MemberFormStep,
    type MemberFormData,
} from "../components/member-form-step";
import { MemberReviewStep } from "../components/member-review-step";
import { getDisabledRolesForMemberEdit } from "../utils/disabled-roles";
import { applyMemberRolesToPolicy } from "../utils/policy-helpers";

export default function AddMemberPage() {
    const t = useTranslations("pages.members");
    const tMembers = useTranslations("members");
    const tAccountInput = useTranslations("accountInput");
    const tMemberValidation = useTranslations("memberValidation");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const { accountId, createProposal } = useNear();
    const { data: policy, isLoading } = useTreasuryPolicy(treasuryId || "");
    const { members: existingMembers } = useTreasuryMembers(treasuryId);

    const [step, setStep] = useState(0);
    const [isValidatingAddresses, setIsValidatingAddresses] = useState(false);
    const hasProcessedUrlParams = useRef(false);

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

    const canAddMember = useMemo(() => {
        if (!policy || !accountId) return false;
        return hasPermission(policy, accountId, "policy", "AddProposal");
    }, [policy, accountId]);

    const availableRoles = useMemo(() => {
        if (!policy?.roles) return [];
        return policy.roles.filter(
            (role) =>
                typeof role.kind === "object" &&
                "Group" in role.kind &&
                role.name.toLowerCase() !== "all",
        );
    }, [policy]);

    const getAccountValidationMessage = useCallback(
        (errorCode: Parameters<typeof translateNearValidationError>[1]) =>
            translateNearValidationError(
                tAccountInput,
                errorCode,
                tMembers("validation.invalidNearAddress"),
            ),
        [tAccountInput, tMembers],
    );

    const addMemberSchema = useMemo(() => {
        const existingMembersSet = new Set(
            existingMembers.map((m) => m.accountId.toLowerCase()),
        );
        return z.object({
            members: z
                .array(
                    z.object({
                        accountId: z
                            .string()
                            .min(1, tMembers("validation.accountIdRequired"))
                            .superRefine(async (accountIdValue, ctx) => {
                                if (!isValidNearAddressFormat(accountIdValue)) {
                                    ctx.addIssue({
                                        code: "custom",
                                        message: tMembers(
                                            "validation.invalidNearAddress",
                                        ),
                                    });
                                    return;
                                }

                                const nearValidationError =
                                    await validateNearAddress(accountIdValue);
                                if (!nearValidationError) return;

                                ctx.addIssue({
                                    code: "custom",
                                    message:
                                        getAccountValidationMessage(
                                            nearValidationError,
                                        ),
                                });
                            }),
                        roles: z
                            .array(z.string())
                            .min(1, tMembers("validation.atLeastOneRole")),
                    }),
                )
                .min(1, tMembers("validation.atLeastOneMember"))
                .superRefine((members, ctx) => {
                    const seenAccountIds = new Map<string, number>();

                    members.forEach((member, index) => {
                        if (!member.accountId) return;

                        const normalizedId = member.accountId.toLowerCase();
                        const firstOccurrence =
                            seenAccountIds.get(normalizedId);
                        if (firstOccurrence !== undefined) {
                            ctx.addIssue({
                                code: "custom",
                                message: tMembers("validation.alreadyAdded"),
                                path: [index, "accountId"],
                            });
                        } else {
                            seenAccountIds.set(normalizedId, index);

                            if (existingMembersSet.has(normalizedId)) {
                                ctx.addIssue({
                                    code: "custom",
                                    message: tMembers(
                                        "validation.alreadyInTreasury",
                                    ),
                                    path: [index, "accountId"],
                                });
                            }
                        }
                    });
                }),
        });
    }, [existingMembers, tMembers, getAccountValidationMessage]);

    const form = useForm<MemberFormData>({
        resolver: zodResolver(addMemberSchema),
        mode: "onChange",
        defaultValues: {
            members: [{ accountId: "", roles: [] }],
        },
    });

    // Only bounce away if a pending ChangePolicy already exists when the page
    // first becomes ready. Do not redirect when pending flips mid-submit (e.g.
    // after the wallet tx lands) — that races ahead of the success toast.
    const didCheckInitialPending = useRef(false);
    useEffect(() => {
        if (!isMemberDataReady || didCheckInitialPending.current) return;
        didCheckInitialPending.current = true;
        if (hasPendingMemberRequest && treasuryId) {
            router.replace(`/${treasuryId}/members`);
        }
    }, [isMemberDataReady, hasPendingMemberRequest, router, treasuryId]);

    useEffect(() => {
        const memberParam = searchParams.get("member");
        const rolesParam = searchParams.get("roles");

        // Prefill from URL as soon as roles are available — do not wait on the
        // pending-proposal query (isMemberActionsDisabled). That query can lag
        // or error and would leave the deep link empty.
        if (
            memberParam &&
            canAddMember &&
            availableRoles.length > 0 &&
            !hasProcessedUrlParams.current
        ) {
            hasProcessedUrlParams.current = true;

            let rolesToAdd: string[] = [];
            if (rolesParam) {
                const requestedRoles = rolesParam
                    .split(",")
                    .map((r) => r.trim())
                    .filter(Boolean);

                rolesToAdd = requestedRoles
                    .map(
                        (requestedRole) =>
                            availableRoles.find(
                                (policyRole) =>
                                    policyRole.name.toLowerCase() ===
                                    requestedRole.toLowerCase(),
                            )?.name,
                    )
                    .filter((role): role is string => role !== undefined);
            }

            form.setValue("members", [
                {
                    accountId: memberParam,
                    roles: rolesToAdd,
                },
            ]);
        }
    }, [searchParams, canAddMember, form, availableRoles]);

    const exitToMembers = useCallback(() => {
        router.push(`/${treasuryId}/members`);
    }, [router, treasuryId]);

    const membersInForm = form.watch("members") || [];

    // Same NEARN requestor lock as edit: only AddProposal (or :*) roles selectable.
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

        trackEvent("member-add-review-clicked", { treasury_id: treasuryId });

        setIsValidatingAddresses(true);
        const members = form.getValues("members");

        try {
            const validationResults = await Promise.all(
                members.map((member, index) =>
                    validateNearAddress(member.accountId).then((error) => ({
                        index,
                        error,
                    })),
                ),
            );

            const failedValidation = validationResults.find(
                (result) => result.error,
            );
            if (failedValidation) {
                form.setError(`members.${failedValidation.index}.accountId`, {
                    type: "manual",
                    message:
                        (failedValidation.error
                            ? getAccountValidationMessage(
                                  failedValidation.error,
                              )
                            : undefined) ||
                        tMembers("validation.invalidNearAddress"),
                });
                setIsValidatingAddresses(false);
                return;
            }

            setIsValidatingAddresses(false);
            setStep(1);
        } catch (error) {
            console.error("Error validating addresses:", error);
            setIsValidatingAddresses(false);
        }
    }, [form, treasuryId, getAccountValidationMessage, tMembers]);

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
            false,
        );

        if (!updatedPolicy) return;

        const description = {
            title: tMembers("policy.addMembers"),
            summary,
        };

        try {
            // createProposal shows the success toast before resolving; only
            // navigate once that completes so a rejected wallet stays on review.
            await createProposal(tMembers("policy.addMembersSuccess"), {
                treasuryId,
                proposalBond: policy?.proposal_bond || "0",
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

            trackEvent("member-add-submitted", {
                treasury_id: treasuryId,
                members_count: data.members.length,
            });

            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });

            router.push(`/${treasuryId}/members`);
        } catch (error) {
            console.error("Failed to add members:", error);
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
                    isValidatingAddresses,
                    mode: "add" as const,
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
                    mode: "add" as const,
                },
            },
        ],
        [
            availableRoles,
            isValidatingAddresses,
            getDisabledRoles,
            hasPendingMemberRequest,
            tMemberValidation,
            handleReviewRequest,
            exitToMembers,
            handleSubmit,
        ],
    );

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <div className="max-w-xl mx-auto w-full">
                <FormProvider {...form}>
                    {isLoading ? (
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

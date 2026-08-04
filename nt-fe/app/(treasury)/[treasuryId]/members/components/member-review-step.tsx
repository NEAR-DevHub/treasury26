"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { PageCard } from "@/components/card";
import { RoleBadge } from "@/components/role-badge";
import { StepperHeader, type StepProps } from "@/components/step-wizard";
import { User } from "@/components/user";
import { sortRolesByOrder } from "@/lib/role-utils";
import type { MemberFormData } from "./member-form-step";

interface MemberReviewStepProps extends StepProps {
    onSubmit: () => Promise<void>;
    validationError?: string;
    mode?: "add" | "edit";
    /** Join-request review: show profile name + id without avatar */
    showJoinProfiles?: boolean;
    existingMembers?: Array<{
        accountId: string;
        roles: string[];
    }>;
}

export function MemberReviewStep({
    handleBack,
    onSubmit,
    validationError,
    mode = "add",
    showJoinProfiles = false,
    existingMembers = [],
}: MemberReviewStepProps) {
    const t = useTranslations("members.previewModal");
    const form = useFormContext<MemberFormData>();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const members = form.watch("members") ?? [];
    const isEditMode = mode === "edit";

    const membersToShow = isEditMode
        ? members.filter((member) => {
              const existingMember = existingMembers.find(
                  (m) => m.accountId === member.accountId,
              );
              if (!existingMember) return false;

              const currentRolesSorted = sortRolesByOrder([
                  ...(member.roles ?? []),
              ]).join(",");
              const existingRolesSorted = sortRolesByOrder([
                  ...existingMember.roles,
              ]).join(",");

              return currentRolesSorted !== existingRolesSorted;
          })
        : members;

    const handleSubmit = async () => {
        setIsSubmitting(true);
        try {
            await onSubmit();
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <PageCard className="gap-4">
            <StepperHeader
                title={t("title")}
                handleBack={handleBack}
                backDisabled={isSubmitting}
            />
            <div className="space-y-4">
                <div className="text-center py-8 bg-muted/50 rounded-lg">
                    {isEditMode ? (
                        <>
                            <p className="text-sm text-muted-foreground mb-2">
                                {t("youAreEditing")}
                            </p>
                            <h3 className="text-3xl font-bold">
                                {t("membersCount", {
                                    count: membersToShow.length,
                                })}
                            </h3>
                        </>
                    ) : (
                        <>
                            <p className="text-sm text-muted-foreground mb-2">
                                {t("youAreAdding")}
                            </p>
                            <h3 className="text-3xl font-bold">
                                {t("newMembersCount", {
                                    count: membersToShow.length,
                                })}
                            </h3>
                        </>
                    )}
                </div>

                <div>
                    <h4 className="font-semibold pb-3">
                        {isEditMode ? t("updatedMembers") : t("newMembers")}
                    </h4>
                    <div className="space-y-0 rounded-lg overflow-hidden">
                        {membersToShow.map((member, index) => (
                            <div
                                key={isEditMode ? member.accountId : index}
                                className="flex items-center justify-between p-4 px-0 gap-4 border-b-2"
                            >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <span className="flex items-center justify-center w-8 h-8 bg-muted rounded-full text-muted-foreground text-sm font-medium shrink-0">
                                        {index + 1}
                                    </span>
                                    {showJoinProfiles ? (
                                        <User
                                            accountId={member.accountId}
                                            variant="details"
                                            withLink={false}
                                        />
                                    ) : (
                                        <span className="font-medium break-all">
                                            {member.accountId}
                                        </span>
                                    )}
                                </div>
                                <div className="flex gap-2 flex-wrap shrink-0">
                                    {sortRolesByOrder(member.roles ?? []).map(
                                        (role) => (
                                            <RoleBadge
                                                key={role}
                                                role={role}
                                                variant="rounded"
                                            />
                                        ),
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <ButtonWithTooltip
                type="button"
                onClick={handleSubmit}
                className="w-full"
                disabled={isSubmitting || !!validationError}
                tooltipMessage={validationError}
            >
                {isSubmitting ? t("creatingProposal") : t("confirmSubmit")}
            </ButtonWithTooltip>
        </PageCard>
    );
}

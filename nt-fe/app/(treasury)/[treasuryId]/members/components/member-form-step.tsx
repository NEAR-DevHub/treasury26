"use client";

import { useTranslations } from "next-intl";
import { useFormContext } from "react-hook-form";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { PageCard } from "@/components/card";
import { MemberInput } from "@/components/member-input";
import { useFormatRoleName } from "@/components/role-name";
import { type StepProps, StepperHeader } from "@/components/step-wizard";
import { sortRolesByOrder } from "@/lib/role-utils";
import { useRoleDescription } from "@/lib/use-role-description";
import type { RolePermission } from "@/types/policy";

export interface MemberFormData {
    members: Array<{
        accountId: string;
        roles: string[];
    }>;
}

interface MemberFormStepProps extends StepProps {
    availableRoles: RolePermission[];
    isValidatingAddresses: boolean;
    mode: "add" | "edit";
    validationError?: string;
    originalMembers?: Array<{
        accountId: string;
        roles: string[];
    }>;
    getDisabledRoles?: (
        accountId: string,
        currentRoles: string[],
    ) => { roleId: string; reason: string }[];
    onReviewRequest: () => void | Promise<void>;
    /** When set, back leaves the page flow instead of previous wizard step */
    onExit?: () => void;
}

export function MemberFormStep({
    handleBack,
    availableRoles,
    isValidatingAddresses,
    mode,
    validationError,
    originalMembers,
    getDisabledRoles,
    onReviewRequest,
    onExit,
}: MemberFormStepProps) {
    const t = useTranslations("members.memberModal");
    const form = useFormContext<MemberFormData>();
    const formatRoleName = useFormatRoleName();
    const getRoleDescription = useRoleDescription();
    const isEditMode = mode === "edit";
    const title = isEditMode ? t("editRoles") : t("addNewMember");
    const buttonText = isValidatingAddresses
        ? t("validatingAddresses")
        : t("reviewRequest");

    const hasChanges = (() => {
        if (!isEditMode || !originalMembers) return true;

        const currentMembers = form.watch("members");

        return currentMembers.some((currentMember) => {
            const originalMember = originalMembers.find(
                (m) => m.accountId === currentMember.accountId,
            );
            if (!originalMember) return true;

            const currentRolesSorted = [...currentMember.roles].sort();
            const originalRolesSorted = [...originalMember.roles].sort();

            return (
                currentRolesSorted.length !== originalRolesSorted.length ||
                currentRolesSorted.some(
                    (role, index) => role !== originalRolesSorted[index],
                )
            );
        });
    })();

    const mappedRoles = (() => {
        const mapped = availableRoles.map((r) => ({
            id: r.name,
            title: formatRoleName(r.name),
            description: getRoleDescription(r.name),
        }));
        const roleNames = mapped.map((r) => r.id);
        const sortedNames = sortRolesByOrder(roleNames);
        return sortedNames.map((name) => mapped.find((r) => r.id === name)!);
    })();

    return (
        <PageCard className="gap-4">
            <StepperHeader title={title} handleBack={onExit ?? handleBack} />
            <MemberInput
                control={form.control}
                name="members"
                mode={mode}
                availableRoles={mappedRoles}
                getDisabledRoles={getDisabledRoles}
            />
            <ButtonWithTooltip
                type="button"
                onClick={() => {
                    void onReviewRequest();
                }}
                disabled={
                    !form.formState.isValid ||
                    isValidatingAddresses ||
                    !!validationError ||
                    (isEditMode && !hasChanges)
                }
                className="w-full"
                tooltipMessage={
                    validationError ||
                    (isEditMode && !hasChanges ? t("noChanges") : undefined)
                }
            >
                {buttonText}
            </ButtonWithTooltip>
        </PageCard>
    );
}

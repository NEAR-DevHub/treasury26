"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import type { RolePermission } from "@/types/policy";
import { getDisabledRolesForMemberEdit } from "../utils/disabled-roles";
import type { ExistingMember } from "../utils/policy-helpers";

type FormMember = {
    accountId: string;
    roles: string[];
};

/**
 * NEARN requestor lock + last-member-in-role protection for role pickers.
 */
export function useDisabledMemberRoles(
    membersInForm: FormMember[],
    existingMembers: ExistingMember[],
    availableRoles: RolePermission[],
) {
    const tMembers = useTranslations("members");

    return useCallback(
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
}

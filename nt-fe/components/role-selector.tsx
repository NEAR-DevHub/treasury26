"use client";

import { Icon } from "@/components/icon";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

type Role = {
    id: string;
    title: string;
    description?: string;
};

export const ROLES: readonly Role[] = [
    {
        id: "governance",
        title: "Governance",
        description:
            "Governance can create and vote on team-related treasury settings, including members, permissions, and treasury appearance.",
    },
    {
        id: "requestor",
        title: "Requestor",
        description:
            "Requestor can create payment-related transaction requests, without voting or approval rights.",
    },
    {
        id: "financial",
        title: "Financial",
        description:
            "Financial can vote on payment-related transaction requests but cannot create them.",
    },
] as const;

const CANONICAL_ROLE_IDS = new Set(["governance", "requestor", "financial"]);

function normalizeRoleId(roleId: string): string {
    const normalized = roleId.trim().toLowerCase();

    if (normalized === "admin" || normalized === "manage members") {
        return "governance";
    }
    if (normalized === "approver" || normalized === "vote") {
        return "financial";
    }
    if (normalized === "create requests") {
        return "requestor";
    }

    return normalized;
}

function useTranslatedRoles(availableRoles: readonly Role[]): Role[] {
    const t = useTranslations("roleSelector.roles");
    return availableRoles.map((role) => {
        const canonical = normalizeRoleId(role.id);
        if (!CANONICAL_ROLE_IDS.has(canonical)) {
            return { ...role };
        }
        return {
            ...role,
            title: t(`${canonical}.title`),
            description: t(`${canonical}.description`),
        };
    });
}

interface RoleSelectorProps {
    selectedRoles?: string[];
    onRolesChange?: (roles: string[]) => void;
    className?: string;
    availableRoles?: readonly Role[];
    disabledRoles?: { roleId: string; reason: string }[];
}

export function RoleSelector({
    selectedRoles = [],
    onRolesChange,
    availableRoles = ROLES,
    disabledRoles = [],
}: RoleSelectorProps) {
    const t = useTranslations("roleSelector");
    const translatedRoles = useTranslatedRoles(availableRoles);
    const [open, setOpen] = React.useState(false);

    const handleRoleToggle = (roleId: string) => {
        const isDisabled = disabledRoles.some((d) => d.roleId === roleId);
        if (isDisabled) return;

        const newRoles = selectedRoles.includes(roleId)
            ? selectedRoles.filter((id) => id !== roleId)
            : [...selectedRoles, roleId];
        onRolesChange?.(newRoles);
    };

    const getButtonText = () => {
        if (selectedRoles.length === 0) {
            return t("setRole");
        } else if (selectedRoles.length === translatedRoles.length) {
            return t("allRoles");
        }
        const selectedRoleTitles = selectedRoles
            .sort((a, b) => a.localeCompare(b))
            .map((id) => translatedRoles.find((r) => r.id === id)?.title)
            .filter(Boolean);
        return selectedRoleTitles.join(", ");
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    className="flex gap-2 items-center bg-card rounded-full"
                >
                    {getButtonText()}
                    <Icon
                        icon={ArrowDown01Icon}
                        className="shrink-0 opacity-50"
                    />
                </Button>
            </PopoverTrigger>
            {/*
              Align to the trailing edge so label width changes don't shift the
              menu horizontally. Keep collision handling so the last row can
              flip above when there's no room below.
            */}
            <PopoverContent
                className="w-80 p-1 gap-1 flex flex-col"
                align="end"
                collisionPadding={16}
            >
                {translatedRoles.map((role) => {
                    const disabledInfo = disabledRoles.find(
                        (d) => d.roleId === role.id,
                    );
                    const isDisabled = !!disabledInfo;
                    const isChecked = selectedRoles.includes(role.id);

                    const content = (
                        <label
                            key={role.id}
                            className={`flex items-start space-x-3 rounded-md p-3 transition-colors ${
                                isDisabled
                                    ? "opacity-60 cursor-not-allowed"
                                    : "cursor-pointer hover:bg-accent"
                            }`}
                            onClick={(e) => {
                                if (isDisabled) {
                                    e.preventDefault();
                                }
                            }}
                        >
                            <Checkbox
                                checked={isChecked}
                                onCheckedChange={() =>
                                    handleRoleToggle(role.id)
                                }
                                className="mt-0.5"
                                disabled={isDisabled}
                            />
                            <div className="flex-1 space-y-1">
                                <p className="text-sm font-medium leading-none mt-0.5">
                                    {role.title}
                                </p>
                                {role.description && (
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        {role.description}
                                    </p>
                                )}
                            </div>
                        </label>
                    );

                    if (isDisabled && disabledInfo) {
                        return (
                            <Tooltip
                                key={role.id}
                                content={disabledInfo.reason}
                                contentProps={{ className: "max-w-[320px]" }}
                            >
                                {content}
                            </Tooltip>
                        );
                    }

                    return content;
                })}
            </PopoverContent>
        </Popover>
    );
}

"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "./button"

type Role = {
    id: string
    title: string
    description: string
}

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

interface RoleSelectorProps {
    selectedRoles?: string[]
    onRolesChange?: (roles: string[]) => void
    className?: string
}

export function RoleSelector({
    selectedRoles = [],
    onRolesChange,
}: RoleSelectorProps) {
    const [open, setOpen] = React.useState(false)

    const handleRoleToggle = (roleId: string) => {
        const newRoles = selectedRoles.includes(roleId)
            ? selectedRoles.filter((id) => id !== roleId)
            : [...selectedRoles, roleId]
        onRolesChange?.(newRoles)
    }

    const getButtonText = () => {
        if (selectedRoles.length === 0) {
            return "Set Role"
        } else if (selectedRoles.length === 3) {
            return "Full Access"
        }
        const selectedRoleTitles = selectedRoles
            .sort((a, b) => a.localeCompare(b))
            .map((id) => ROLES.find((r) => r.id === id)?.title)
            .filter(Boolean)
        return selectedRoleTitles.join(", ")
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" className="flex gap-2 items-center bg-card rounded-full" >
                    {getButtonText()}
                    <ChevronDown className="size-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="start">
                <div className="space-y-1 p-4">
                    {ROLES.map((role) => (
                        <label
                            key={role.id}
                            className="flex cursor-pointer items-start space-x-3 rounded-md p-3 transition-colors hover:bg-accent"
                        >
                            <Checkbox
                                checked={selectedRoles.includes(role.id)}
                                onCheckedChange={() => handleRoleToggle(role.id)}
                                className="mt-0.5"
                            />
                            <div className="flex-1 space-y-1">
                                <p className="text-sm font-medium leading-none">{role.title}</p>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    {role.description}
                                </p>
                            </div>
                        </label>
                    ))}
                </div>
            </PopoverContent>
        </Popover >
    )
}

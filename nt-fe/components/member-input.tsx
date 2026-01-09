"use client";

import { Button } from "./button";
import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import { ArrayPath, Control, FieldValues, Path, PathValue, useFieldArray, useFormContext, useWatch } from "react-hook-form";
import z from "zod";
import { AccountIdInput, accountIdSchema } from "./account-id-input";
import { ROLES, RoleSelector } from "./role-selector";
import { Pill } from "./pill";
import { Plus, Trash2 } from "lucide-react";
import { Tooltip } from "./tooltip";

export const memberSchema = z.array(z.object({
    accountId: accountIdSchema,
    roles: z.array(z.enum(ROLES.map(r => r.id))).min(1, "At least one role is required"),
})).superRefine((data, ctx) => {
    const sortedData = data.sort((a, b) => a.accountId.localeCompare(b.accountId));
    for (const [index, member] of sortedData.entries()) {
        if (index < sortedData.length - 1 && member.accountId === sortedData[index + 1]?.accountId) {
            ctx.addIssue({
                code: "custom",
                message: "Address already exists",
                path: [`${index + 1}.accountId`],
            });
        }
    }
});

export type MembersArray = z.infer<typeof memberSchema>;
export type Member = z.infer<typeof memberSchema>[number];

type Role = {
    id: string
    title: string
    description?: string
}

type MemberInputMode = "onboarding" | "add" | "edit";

interface MemberInputProps<
    TFieldValues extends FieldValues = FieldValues,
    TMemberPath extends Path<TFieldValues> = Path<TFieldValues>
> {
    control: Control<TFieldValues>;
    mode?: MemberInputMode;
    availableRoles?: readonly Role[];
    name: TMemberPath extends ArrayPath<TFieldValues>
    ? PathValue<TFieldValues, TMemberPath> extends MembersArray
    ? TMemberPath
    : never
    : never;
}

export function MemberInput<
    TFieldValues extends FieldValues = FieldValues,
    TMemberPath extends Path<TFieldValues> = Path<TFieldValues>
>({ control, mode = "add", availableRoles = ROLES, name }: MemberInputProps<TFieldValues, TMemberPath>) {
    const { fields, append, remove } = useFieldArray({
        control,
        name: name,
    });

    // Derive behavior from mode
    const isOnboarding = mode === "onboarding";
    const isEditMode = mode === "edit";
    const lockedFirstMember = isOnboarding;
    const showCreatorLabel = isOnboarding;
    const hideAddButton = isEditMode;
    const disableAllInputs = isEditMode;
    const defaultRoles = isOnboarding ? ["requestor"] : [];

    return (
        <InputBlock invalid={false}>
            <div className="flex flex-col gap-4">
                {fields.map((field, index) => (
                    <div key={field.id} className={`flex flex-col gap-0 ${!hideAddButton || index < fields.length - 1 ? 'border-b border-muted-foreground/10' : ''}`}>
                        <div className="flex justify-between items-center">
                            <p className="text-xs text-muted-foreground">
                                {showCreatorLabel && index === 0 ? "Creator" : "Member Address"}
                            </p>

                            {index > 0 && !disableAllInputs && <Button variant={"ghost"} className="size-6 p-0! group hover:text-destructive" onClick={() => remove(index)}>
                                <Trash2 className="size-4 text-primary group-hover:text-destructive" />
                            </Button>}
                        </div>
                        <div className="flex md:flex-row flex-col items-start justify-between md:items-center gap-3">
                            <div className="flex-1 wrap-break-word overflow-wrap-anywhere min-w-0">
                                <AccountIdInput
                                    disabled={disableAllInputs || (lockedFirstMember && index === 0)}
                                    control={control}
                                    name={`${name}.${index}.accountId`! as any}
                                />
                            </div>
                            <FormField
                                control={control}
                                name={`${name}.${index}.roles` as Path<TFieldValues>}
                                render={({ field }) => (
                                    <>
                                        {disableAllInputs ? (
                                            <RoleSelector
                                                selectedRoles={field.value}
                                                onRolesChange={(roles) => {
                                                    field.onChange(roles);
                                                }}
                                                availableRoles={availableRoles}
                                            />
                                        ) : (index > 0 || !lockedFirstMember) ? (
                                            <RoleSelector
                                                selectedRoles={field.value}
                                                onRolesChange={(roles) => {
                                                    field.onChange(roles);
                                                }}
                                                availableRoles={availableRoles}
                                            />
                                        ) : (
                                            <div className="flex gap-1">
                                                {availableRoles.filter(r => field.value.includes(r.id)).map(r => {
                                                    return (
                                                        <Tooltip key={r.id} content={r.description} triggerProps={{ asChild: false }}>
                                                            <Pill title={r.title} variant="secondary" />
                                                        </Tooltip>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </>
                                )}
                            />
                        </div>
                        <div className="flex justify-between gap-1">
                            <FormField
                                control={control}
                                name={`${name}.${index}.accountId` as Path<TFieldValues>}
                                render={({ fieldState }) => (
                                    fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Invisible</p>
                                )}
                            />
                            <FormField
                                control={control}
                                name={`${name}.${index}.roles` as Path<TFieldValues>}
                                render={({ fieldState }) => (
                                    fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Invisible</p>
                                )}
                            />
                        </div>
                    </div>
                ))}
                {!hideAddButton && (
                <Button variant={"ghost"} type="button" className="w-fit" onClick={() => append({ accountId: "", roles: defaultRoles } as TMemberPath extends ArrayPath<TFieldValues>
                    ? PathValue<TFieldValues, TMemberPath> extends Member
                    ? PathValue<TFieldValues, TMemberPath>[number]
                    : never
                    : never)}>
                    <Plus className="size-4 text-primary" />
                    <span className="text-primary">Add New Member</span>
                </Button>
                )}
            </div>
        </InputBlock >
    )
}

"use client";

import { useMemo } from "react";
import { Button } from "./button";
import { useTokenBalance, useTokenPrice } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { cn, formatBalance } from "@/lib/utils";
import TokenSelect from "./token-select";
import { LargeInput } from "./large-input";
import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import { ArrayPath, Control, FieldValues, Path, PathValue, useFieldArray, useFormContext, useWatch } from "react-hook-form";
import z from "zod";
import { AccountIdInput, accountIdSchema } from "./account-id-input";
import { RoleSelector } from "./role-selector";
import { Pill } from "./pill";
import { Plus, Trash, Trash2 } from "lucide-react";

export const memberSchema = z.array(z.object({
    accountId: accountIdSchema,
    roles: z.array(z.enum(["governance", "requestor", "financial"])).min(1, "At least one role is required"),
}));

export type MembersArray = z.infer<typeof memberSchema>;
export type Member = z.infer<typeof memberSchema>[number];

interface MemberInputProps<
    TFieldValues extends FieldValues = FieldValues,
    TMemberPath extends Path<TFieldValues> = Path<TFieldValues>
> {
    control: Control<TFieldValues>;
    lockedFirstMember?: boolean;
    name: TMemberPath extends ArrayPath<TFieldValues>
    ? PathValue<TFieldValues, TMemberPath> extends MembersArray
    ? TMemberPath
    : never
    : never;
}

export function MemberInput<
    TFieldValues extends FieldValues = FieldValues,
    TMemberPath extends Path<TFieldValues> = Path<TFieldValues>
>({ control, lockedFirstMember, name }: MemberInputProps<TFieldValues, TMemberPath>) {
    const { fields, append, remove } = useFieldArray({
        control,
        name: name,
    });

    return (
        <InputBlock invalid={false}>
            <div className="flex flex-col gap-4">
                {fields.map((field, index) => (
                    <div key={field.id} className="flex  flex-col gap-0 border-b border-muted-foreground/10">
                        <div className="flex justify-between items-center">
                            <p className="text-xs text-muted-foreground">
                                {index === 0 ? "Creator" : "Member Address"}
                            </p>
                            {index > 0 && <Button variant={"ghost"} className="size-6 p-0! group hover:text-destructive" onClick={() => remove(index)}>
                                <Trash2 className="size-4 text-primary group-hover:text-destructive" />
                            </Button>}
                        </div>
                        <div className="flex md:flex-row flex-col items-start justify-between md:items-center">
                            <div className="flex-1">
                                <AccountIdInput
                                    disabled={lockedFirstMember && index === 0}
                                    control={control}
                                    name={`${name}.${index}.accountId`! as any}
                                />
                            </div>
                            <FormField
                                control={control}
                                name={`${name}.${index}.roles` as Path<TFieldValues>}
                                render={({ field }) => (
                                    <>
                                        {index > 0 || !lockedFirstMember ? (
                                            <RoleSelector
                                                selectedRoles={field.value}
                                                onRolesChange={(roles) => {
                                                    field.onChange(roles);
                                                }}
                                            />
                                        ) : (
                                            <div className="flex gap-1">
                                                {field.value.map((role: string) => <Pill key={role} title={role.charAt(0).toUpperCase() + role.slice(1)} variant="secondary" />)}
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
                <Button variant={"ghost"} className="w-fit pl-0! group hover:text-muted-foreground" onClick={() => append({ accountId: "", roles: ["requestor"] } as TMemberPath extends ArrayPath<TFieldValues>
                    ? PathValue<TFieldValues, TMemberPath> extends Member
                    ? PathValue<TFieldValues, TMemberPath>[number]
                    : never
                    : never)}>
                    <Plus className="size-4 text-primary group-hover:text-muted-foreground" />
                    Add New Member
                </Button>
            </div>
        </InputBlock >
    )
}

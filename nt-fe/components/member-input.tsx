"use client";

import { Button } from "./button";
import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import {
    ArrayPath,
    Control,
    FieldValues,
    Path,
    PathValue,
    useFieldArray,
    useFormContext,
} from "react-hook-form";
import z from "zod";
import { useTranslations } from "next-intl";
import { AccountIdInput, buildAccountIdSchema } from "./account-id-input";
import { ROLES, RoleSelector } from "./role-selector";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { RoleBadge } from "./role-badge";

export function buildMemberSchema(messages: {
    rolesRequired: string;
    duplicateAddress: string;
    accountId: {
        minLength: string;
        maxLength: string;
        charset: string;
        doesNotExist: string;
    };
}) {
    return z
        .array(
            z.object({
                accountId: buildAccountIdSchema(messages.accountId),
                roles: z
                    .array(z.enum(ROLES.map((r) => r.id)))
                    .min(1, messages.rolesRequired),
            }),
        )
        .superRefine((data, ctx) => {
            const sortedData = data.sort((a, b) =>
                a.accountId.localeCompare(b.accountId),
            );
            for (const [index, member] of sortedData.entries()) {
                if (
                    index < sortedData.length - 1 &&
                    member.accountId === sortedData[index + 1]?.accountId
                ) {
                    ctx.addIssue({
                        code: "custom",
                        message: messages.duplicateAddress,
                        path: [index + 1, "accountId"],
                    });
                }
            }
        });
}

const _memberSchemaForTypes = buildMemberSchema({
    rolesRequired: "",
    duplicateAddress: "",
    accountId: {
        minLength: "",
        maxLength: "",
        charset: "",
        doesNotExist: "",
    },
});

export type MembersArray = z.infer<typeof _memberSchemaForTypes>;
export type Member = MembersArray[number];

type Role = {
    id: string;
    title: string;
    description?: string;
};

type MemberInputMode = "onboarding" | "add" | "edit";

interface MemberInputProps<
    TFieldValues extends FieldValues = FieldValues,
    TMemberPath extends Path<TFieldValues> = Path<TFieldValues>,
> {
    control: Control<TFieldValues>;
    mode?: MemberInputMode;
    availableRoles?: readonly Role[];
    name: TMemberPath extends ArrayPath<TFieldValues>
        ? PathValue<TFieldValues, TMemberPath> extends MembersArray
            ? TMemberPath
            : never
        : never;
    getDisabledRoles?: (
        accountId: string,
        currentRoles: string[],
    ) => { roleId: string; reason: string }[];
}

export function MemberInput<
    TFieldValues extends FieldValues = FieldValues,
    TMemberPath extends Path<TFieldValues> = Path<TFieldValues>,
>({
    control,
    mode = "add",
    availableRoles = ROLES,
    name,
    getDisabledRoles,
}: MemberInputProps<TFieldValues, TMemberPath>) {
    const t = useTranslations("memberInput");
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
    const defaultRoles: string[] = [];

    return (
        <InputBlock invalid={false} className="p-0">
            <div className="flex flex-col">
                {fields.map((field, index) => (
                    <div
                        key={field.id}
                        className={cn(
                            "flex px-3.5 first:rounded-t-xl first:pt-3 not-first:pt-2 last:pb-3 flex-col gap-0",
                            !disableAllInputs &&
                                (!lockedFirstMember || index !== 0) &&
                                "focus-within:bg-general-tertiary hover:bg-general-tertiary transition-colors",
                            (!hideAddButton || index < fields.length - 1) &&
                                "border-b border-muted-foreground/10",
                        )}
                    >
                        <div className="flex justify-between items-center">
                            <p className="text-xs text-muted-foreground">
                                {showCreatorLabel && index === 0
                                    ? t("creatorYou")
                                    : t("memberAddress")}
                            </p>

                            {index > 0 && !disableAllInputs && (
                                <Button
                                    variant={"ghost"}
                                    className="size-6 p-0! group hover:text-destructive"
                                    onClick={() => remove(index)}
                                >
                                    <Trash2 className="size-4 text-foreground group-hover:text-destructive" />
                                </Button>
                            )}
                        </div>
                        <div className="flex md:flex-row flex-col items-start justify-between md:items-center gap-3">
                            <div className="flex-1 wrap-break-word overflow-wrap-anywhere min-w-0">
                                <AccountIdInput
                                    disabled={
                                        disableAllInputs ||
                                        (lockedFirstMember && index === 0)
                                    }
                                    control={control}
                                    name={`${name}.${index}.accountId`! as any}
                                />
                            </div>
                            <FormField
                                control={control}
                                name={
                                    `${name}.${index}.roles` as Path<TFieldValues>
                                }
                                render={({ field }) => {
                                    const form = useFormContext();
                                    const accountId = form.watch(
                                        `${name}.${index}.accountId`,
                                    );
                                    const disabledRoles =
                                        getDisabledRoles && accountId
                                            ? getDisabledRoles(
                                                  accountId,
                                                  field.value || [],
                                              )
                                            : [];

                                    return (
                                        <>
                                            {disableAllInputs ? (
                                                <RoleSelector
                                                    selectedRoles={field.value}
                                                    onRolesChange={(roles) => {
                                                        field.onChange(roles);
                                                    }}
                                                    availableRoles={
                                                        availableRoles
                                                    }
                                                    disabledRoles={
                                                        disabledRoles
                                                    }
                                                />
                                            ) : index > 0 ||
                                              !lockedFirstMember ? (
                                                <RoleSelector
                                                    selectedRoles={field.value}
                                                    onRolesChange={(roles) => {
                                                        field.onChange(roles);
                                                    }}
                                                    availableRoles={
                                                        availableRoles
                                                    }
                                                    disabledRoles={
                                                        disabledRoles
                                                    }
                                                />
                                            ) : (
                                                <div className="flex flex-wrap items-center gap-2">
                                                    {ROLES.map((role) => (
                                                        <RoleBadge
                                                            key={role.id}
                                                            role={role.id}
                                                            variant="pill"
                                                            style="secondary"
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                        </>
                                    );
                                }}
                            />
                        </div>
                        <div className="flex justify-between gap-1">
                            <FormField
                                control={control}
                                name={
                                    `${name}.${index}.accountId` as Path<TFieldValues>
                                }
                                render={({ fieldState }) =>
                                    fieldState.error ? (
                                        <FormMessage className="text-sm mb-3" />
                                    ) : (
                                        <p className="text-muted-foreground text-xs invisible">
                                            Invisible
                                        </p>
                                    )
                                }
                            />
                            <FormField
                                control={control}
                                name={
                                    `${name}.${index}.roles` as Path<TFieldValues>
                                }
                                render={({ fieldState }) =>
                                    fieldState.error ? (
                                        <FormMessage />
                                    ) : (
                                        <p className="text-muted-foreground text-xs invisible">
                                            Invisible
                                        </p>
                                    )
                                }
                            />
                        </div>
                    </div>
                ))}
                {!hideAddButton && (
                    <Button
                        variant={"ghost"}
                        type="button"
                        className="w-full justify-start rounded-t-none rounded-b-xl pl-3.5!"
                        onClick={() =>
                            append({
                                accountId: "",
                                roles: defaultRoles,
                            } as TMemberPath extends ArrayPath<TFieldValues>
                                ? PathValue<
                                      TFieldValues,
                                      TMemberPath
                                  > extends Member
                                    ? PathValue<
                                          TFieldValues,
                                          TMemberPath
                                      >[number]
                                    : never
                                : never)
                        }
                    >
                        <Plus className="size-4 text-foreground" />
                        <span className="text-foreground">
                            {t("addNewMember")}
                        </span>
                    </Button>
                )}
            </div>
        </InputBlock>
    );
}

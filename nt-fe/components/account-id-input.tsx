"use client";

import { checkAccountExists } from "@/lib/api";
import { Control, FieldValues, Path, PathValue } from "react-hook-form";
import z from "zod";
import { useTranslations } from "next-intl";
import { FormField } from "./ui/form";
import { LargeInput } from "./large-input";

export function buildAccountIdSchema(messages: {
    minLength: string;
    maxLength: string;
    charset: string;
    doesNotExist: string;
}) {
    return (
        z
            .string()
            .min(2, messages.minLength)
            .max(64, messages.maxLength)
            // NEAR account ID format: https://nomicon.io/DataStructures/Account.html
            .regex(
                /^(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+$/,
                messages.charset,
            )
            .refine(
                async (accountId) => {
                    if (!accountId || accountId.length < 2) return true;
                    const result = await checkAccountExists(accountId);
                    return result?.exists === true;
                },
                {
                    message: messages.doesNotExist,
                    path: [""],
                },
            )
    );
}

const _accountIdSchemaForType = buildAccountIdSchema({
    minLength: "",
    maxLength: "",
    charset: "",
    doesNotExist: "",
});

export type AccountId = z.infer<typeof _accountIdSchemaForType>;

interface AccountIdInputProps<
    TFieldValues extends FieldValues = FieldValues,
    TAccountIdPath extends Path<TFieldValues> = Path<TFieldValues>,
> {
    control: Control<TFieldValues>;
    disabled?: boolean;
    name: TAccountIdPath extends Path<TFieldValues>
        ? PathValue<TFieldValues, TAccountIdPath> extends AccountId
            ? TAccountIdPath
            : never
        : never;
}

export function AccountIdInput<
    TFieldValues extends FieldValues = FieldValues,
    TAccountIdPath extends Path<TFieldValues> = Path<TFieldValues>,
>({
    control,
    disabled,
    name,
}: AccountIdInputProps<TFieldValues, TAccountIdPath>) {
    return (
        <FormField
            control={control}
            name={name}
            render={({ field, fieldState }) => (
                <LargeInput
                    disabled={disabled}
                    borderless
                    placeholder="example.near"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    name="wallet-recipient"
                    value={field.value}
                    onChange={(e) => {
                        const input = e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9_.-]+/g, "")
                            .slice(0, 64);
                        field.onChange(input);
                    }}
                    onBlur={field.onBlur}
                />
            )}
        />
    );
}

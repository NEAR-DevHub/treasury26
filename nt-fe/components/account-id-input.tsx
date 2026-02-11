import { checkAccountExists } from "@/lib/api";
import { Control, FieldValues, Path, PathValue } from "react-hook-form";
import z from "zod";
import { FormField } from "./ui/form";
import { LargeInput } from "./large-input";

export const accountIdSchema = z
    .string()
    .min(2, "Account ID should be at least 2 characters")
    .max(64, "Account ID must be less than 64 characters")
    .regex(
        /^[a-z0-9.-]+$/,
        "Account ID can only contain lowercase letters, numbers, hyphens, and underscores",
    )
    .refine(
        async (accountId) => {
            if (!accountId || accountId.length < 2) return true;
            const result = await checkAccountExists(accountId);
            return result?.exists === true;
        },
        {
            message: "Account ID doesn't exist",
            path: [""],
        },
    );

export type AccountId = z.infer<typeof accountIdSchema>;

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
                    placeholder="address.near"
                    autoComplete="off"
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

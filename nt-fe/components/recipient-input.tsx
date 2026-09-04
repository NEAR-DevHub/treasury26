"use client";

import { useTranslations } from "next-intl";
import { WALLET_ADDRESS_INPUT_PROPS } from "@/lib/wallet-address-input-props";
import { InputBlock } from "./input-block";
import { LargeInput } from "./large-input";
import { FormField, FormMessage } from "./ui/form";
import { Control, FieldValues, Path } from "react-hook-form";

interface RecipientInputProps<TFieldValues extends FieldValues = FieldValues> {
    control: Control<TFieldValues>;
    name: Path<TFieldValues>;
}

export function RecipientInput<TFieldValues extends FieldValues = FieldValues>({
    control,
    name,
}: RecipientInputProps<TFieldValues>) {
    const t = useTranslations("recipientInput");
    return (
        <FormField
            control={control}
            name={name}
            render={({ field, fieldState }) => (
                <InputBlock title={t("title")} invalid={!!fieldState.error}>
                    <LargeInput
                        type="text"
                        borderless
                        {...field}
                        {...WALLET_ADDRESS_INPUT_PROPS}
                        placeholder={t("placeholder")}
                    />
                    {fieldState.error ? (
                        <FormMessage />
                    ) : (
                        <p className="text-muted-foreground text-xs invisible">
                            Invisible
                        </p>
                    )}
                </InputBlock>
            )}
        />
    );
}

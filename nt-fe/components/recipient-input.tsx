"use client";

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
    return (
        <FormField
            control={control}
            name={name}
            render={({ field, fieldState }) => (
                <InputBlock title="To" invalid={!!fieldState.error}>
                    <LargeInput type="text" borderless {...field} placeholder="Recipient address" />
                    {fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Invisible</p>}
                </InputBlock>
            )}
        />
    );
}

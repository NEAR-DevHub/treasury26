"use client";

import { InputBlock } from "./input-block";
import { FormField } from "./ui/form";
import { Switch } from "./ui/switch";
import { Control, FieldValues, Path } from "react-hook-form";

interface CheckboxInputProps<TFieldValues extends FieldValues = FieldValues> {
    control: Control<TFieldValues>;
    name: Path<TFieldValues>;
    title: string;
    description: string;
}

export function CheckboxInput<TFieldValues extends FieldValues = FieldValues>({
    control,
    name,
    title,
    description
}: CheckboxInputProps<TFieldValues>) {
    return (
        <FormField
            control={control}
            name={name}
            render={({ field, fieldState }) => (
                <InputBlock invalid={!!fieldState.error}>
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col gap-2">
                            {title && <p className="text-sm text-foreground">{title}</p>}
                            {description && <p className="text-xs text-muted-foreground">{description}</p>}
                        </div>
                        <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                        />
                    </div>
                </InputBlock>
            )}
        />
    );
}

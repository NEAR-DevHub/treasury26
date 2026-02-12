import { InputBlock } from "./input-block";
import { FormField, FormMessage } from "./ui/form";
import { Control, FieldValues, Path } from "react-hook-form";
import { DatePickerPopover } from "./datepicker";

interface DateInputProps<TFieldValues extends FieldValues = FieldValues> {
    control: Control<TFieldValues>;
    name: Path<TFieldValues>;
    title: string;
    minDate?: Date;
    maxDate?: Date;
}

export function DateInput<TFieldValues extends FieldValues = FieldValues>({
    control,
    name,
    title,
    minDate,
    maxDate
}: DateInputProps<TFieldValues>) {
    return (
        <FormField
            control={control}
            name={name}
            render={({ field, fieldState }) => (
                <InputBlock title={title} invalid={!!fieldState.error}>
                    <DatePickerPopover
                        value={field.value}
                        onChange={field.onChange}
                        min={minDate}
                        max={maxDate}
                        showCalendarIcon={false}
                        placeholder="mm/dd/yyyy"

                        classNames={{
                            trigger: "border-none p-0",
                        }}
                    />
                    {fieldState.error ? (
                        <FormMessage />
                    ) : (
                        <p className="text-muted-foreground text-xs invisible">Invisible</p>
                    )}
                </InputBlock>
            )}
        />
    );
}

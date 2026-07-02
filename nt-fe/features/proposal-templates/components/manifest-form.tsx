"use client";

/**
 * Render a validated manifest as a react-hook-form form using the trezu design system: each field
 * is an `InputBlock` (muted card, label as title, help as an info tooltip, red on invalid) wrapping
 * a borderless input chosen by `type`. Validated by `buildFormSchema`; on submit the parsed values
 * go to `onSubmit` for the engine (`buildTemplateProposal`).
 *
 * Inputs are controlled (value/onChange/onBlur, no RHF registration ref) — the same way the house
 * `account-id-input` / payments fields wire LargeInput/Textarea. The form is dynamic (its shape is
 * the runtime manifest), so values flow as the generic `FieldValues`.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { type ControllerRenderProps, useForm } from "react-hook-form";
import { Button } from "@/components/button";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import { Textarea } from "@/components/textarea";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { FieldValues } from "../build-proposal";
import { buildFormSchema, defaultValuesFor } from "../form-schema";
import type { Manifest, ManifestField } from "../manifest";

interface ManifestFormProps {
    manifest: Manifest;
    /** Throw to signal failure (or a missing session); resolving is treated as a filed proposal. */
    onSubmit: (values: FieldValues) => void | Promise<void>;
    submitting?: boolean;
    submitLabel?: string;
}

type FieldControl = ControllerRenderProps<FieldValues, string>;

const SELECT_TRIGGER_CLASS =
    "h-auto w-full border-0 bg-transparent px-0 shadow-none focus-visible:ring-0";

// Same slide as the core step forms: the cleared set exits left, the fresh one enters from the right.
const SLIDE_VARIANTS = {
    enter: { x: "100%", opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit: { x: "-100%", opacity: 0 },
};

/** The current value as a string for text-like inputs (form state is string-valued except bool). */
function asText(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Draw the borderless input that matches a field's `type`. Validation lives in `buildFormSchema`. */
function FieldControlInput({
    field,
    control,
}: {
    field: ManifestField;
    control: FieldControl;
}) {
    const t = useTranslations("customTemplates");
    switch (field.type) {
        case "bool":
            return (
                <div className="pt-1">
                    <Switch
                        checked={Boolean(control.value)}
                        onCheckedChange={control.onChange}
                        onBlur={control.onBlur}
                    />
                </div>
            );
        case "select":
            return (
                <Select
                    value={asText(control.value)}
                    onValueChange={control.onChange}
                >
                    <SelectTrigger
                        className={SELECT_TRIGGER_CLASS}
                        onBlur={control.onBlur}
                    >
                        <SelectValue
                            placeholder={t("form.selectPlaceholder")}
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {(field.options ?? []).map((option) => (
                            <SelectItem key={option} value={option}>
                                {option}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            );
        case "json":
            return (
                <Textarea
                    borderless
                    rows={3}
                    value={asText(control.value)}
                    onChange={control.onChange}
                    onBlur={control.onBlur}
                    placeholder="{ }"
                />
            );
        case "number":
            return (
                <LargeInput
                    borderless
                    type="number"
                    value={asText(control.value)}
                    onChange={control.onChange}
                    onBlur={control.onBlur}
                />
            );
        default:
            // account, token, uint, amount, text — a free string input.
            return (
                <LargeInput
                    borderless
                    value={asText(control.value)}
                    onChange={control.onChange}
                    onBlur={control.onBlur}
                />
            );
    }
}

export function ManifestForm({
    manifest,
    onSubmit,
    submitting,
    submitLabel,
}: ManifestFormProps) {
    const t = useTranslations("customTemplates");
    const tv = useTranslations("customTemplates.validation");
    // Member-facing validation errors stay localized: resolve each message (with the field's label,
    // and the bound for min/max) and hand them to the pure schema builder.
    const schema = useMemo(
        () =>
            buildFormSchema(manifest, {
                required: (label) => tv("required", { label }),
                account: (label) => tv("account", { label }),
                wholeNumber: (label) => tv("wholeNumber", { label }),
                number: (label) => tv("number", { label }),
                select: (label) => tv("select", { label }),
                json: (label) => tv("json", { label }),
                invalid: (label) => tv("invalid", { label }),
                pattern: (label) => tv("pattern", { label }),
                min: (label, min) => tv("min", { label, min }),
                max: (label, max) => tv("max", { label, max }),
            }),
        [manifest, tv],
    );
    const form = useForm<FieldValues>({
        resolver: zodResolver(schema),
        defaultValues: defaultValuesFor(manifest),
        mode: "onBlur",
    });
    // Bumped on a successful submit so the filled fields slide out and a fresh empty set slides in —
    // the same clear-with-slide the core step forms do (StepWizard) when they reset to step 0.
    const [formKey, setFormKey] = useState(0);

    // Clear the form only after a successful submit (the page throws on failure / no session), so a
    // filed proposal leaves an empty form instead of all the values still sitting there.
    const submit = async (values: FieldValues) => {
        try {
            await onSubmit(values);
        } catch {
            return;
        }
        form.reset(defaultValuesFor(manifest));
        setFormKey((key) => key + 1);
    };

    const label = submitLabel ?? t("form.fileProposal");

    return (
        <Form {...form}>
            <form
                onSubmit={form.handleSubmit(submit)}
                className="flex flex-col gap-3"
            >
                <div className="relative overflow-hidden">
                    <AnimatePresence mode="popLayout" initial={false}>
                        <motion.div
                            key={formKey}
                            variants={SLIDE_VARIANTS}
                            initial="enter"
                            animate="center"
                            exit="exit"
                            transition={{
                                x: {
                                    type: "tween",
                                    duration: 0.25,
                                    ease: "easeInOut",
                                },
                                opacity: { duration: 0.2 },
                            }}
                            className="flex flex-col gap-3"
                        >
                            {manifest.fields.map((field) => (
                                <FormField
                                    key={field.name}
                                    control={form.control}
                                    name={field.name}
                                    render={({
                                        field: control,
                                        fieldState,
                                    }) => (
                                        <FormItem>
                                            <InputBlock
                                                title={field.label}
                                                info={field.help}
                                                invalid={!!fieldState.error}
                                                interactive
                                            >
                                                <FieldControlInput
                                                    field={field}
                                                    control={control}
                                                />
                                            </InputBlock>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            ))}
                        </motion.div>
                    </AnimatePresence>
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                    {submitting ? (
                        <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            {label}
                        </>
                    ) : (
                        label
                    )}
                </Button>
            </form>
        </Form>
    );
}

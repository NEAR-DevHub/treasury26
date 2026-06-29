"use client";

/**
 * The Inputs section's row editor + the reusable `FieldConfigFields` block (label / type / required /
 * select options / advanced help+validation+default). `FieldConfigFields` is shared by the standalone
 * `FieldRow` here and by the args editor's inline "dynamic" config, so a member input is configured
 * the same way wherever it's edited. The optional extras (help / validation / default) sit behind a
 * per-row "Advanced options" disclosure that auto-opens when pre-filled or on a validation error,
 * and only the ones a field type allows are shown. Errors render under the input they belong to
 * (after it's touched); `draftToField` drops type-incompatible extras on serialize.
 */
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useId, useState } from "react";
import { Button } from "@/components/button";
import { Textarea } from "@/components/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { type FieldDraft, makeFieldDraft } from "../draft";
import { errorFor } from "../error-map";
import { MANIFEST_FIELD_TYPES, type ManifestFieldType } from "../manifest";

const NUMERIC_TYPES: ManifestFieldType[] = ["uint", "amount", "number"];
const PATTERN_TYPES: ManifestFieldType[] = ["text", "number"];

/** Whether a field already carries any advanced config — used to open the disclosure pre-filled. */
function hasAdvanced(field: FieldDraft): boolean {
    return Boolean(
        field.help ||
            field.default !== undefined ||
            field.validation.min ||
            field.validation.max ||
            field.validation.pattern,
    );
}

interface FieldsBuilderProps {
    fields: FieldDraft[];
    errors: string[];
    /** Field names referenced by an argument/summary placeholder — the rest are flagged unused. */
    usedNames: Set<string>;
    /** Names configured inline on a dynamic argument — hidden here so they aren't double-edited. */
    hideNames?: Set<string>;
    onChange: (fields: FieldDraft[]) => void;
}

export function FieldsBuilder({
    fields,
    errors,
    usedNames,
    hideNames,
    onChange,
}: FieldsBuilderProps) {
    const t = useTranslations("customTemplates");

    function updateField(index: number, patch: Partial<FieldDraft>) {
        onChange(
            fields.map((field, i) =>
                i === index ? { ...field, ...patch } : field,
            ),
        );
    }

    function swapFields(a: number, b: number) {
        const next = [...fields];
        [next[a], next[b]] = [next[b], next[a]];
        onChange(next);
    }

    // Fields configured inline on a dynamic argument are hidden here; number the rest sequentially.
    const visible = fields
        .map((field, index) => ({ field, index }))
        .filter(({ field }) => !hideNames?.has(field.name));

    return (
        <div className="flex flex-col gap-4">
            {visible.map(({ field, index }, displayIndex) => (
                <Fragment key={field.key}>
                    {displayIndex > 0 ? <Separator /> : null}
                    <FieldRow
                        field={field}
                        index={displayIndex}
                        used={field.name === "" || usedNames.has(field.name)}
                        path={`fields.${index}`}
                        errors={errors}
                        canMoveUp={displayIndex > 0}
                        canMoveDown={displayIndex < visible.length - 1}
                        onChange={(patch) => updateField(index, patch)}
                        onRemove={() =>
                            onChange(fields.filter((_, i) => i !== index))
                        }
                        onMove={(delta) => {
                            // Move relative to the visible neighbor, not the raw array slot, so a
                            // swap never lands on a hidden inline-dynamic field.
                            const target = displayIndex + delta;
                            if (target < 0 || target >= visible.length) {
                                return;
                            }
                            swapFields(index, visible[target].index);
                        }}
                    />
                </Fragment>
            ))}
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={() => onChange([...fields, makeFieldDraft()])}
            >
                <Plus className="size-4" /> {t("fields.addField")}
            </Button>
        </div>
    );
}

interface FieldRowProps {
    field: FieldDraft;
    /** Sequential position among the visible "Other inputs" rows, for the "Input N" header. */
    index: number;
    used: boolean;
    path: string;
    errors: string[];
    canMoveUp: boolean;
    canMoveDown: boolean;
    onChange: (patch: Partial<FieldDraft>) => void;
    onRemove: () => void;
    onMove: (delta: number) => void;
}

function FieldRow({
    field,
    index,
    used,
    path,
    errors,
    canMoveUp,
    canMoveDown,
    onChange,
    onRemove,
    onMove,
}: FieldRowProps) {
    const t = useTranslations("customTemplates");
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h4 className="font-semibold text-sm">
                    {t("fields.inputHeading", { number: index + 1 })}
                </h4>
                <div className="flex items-center gap-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canMoveUp}
                        onClick={() => onMove(-1)}
                    >
                        <ChevronUp className="size-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canMoveDown}
                        onClick={() => onMove(1)}
                    >
                        <ChevronDown className="size-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={onRemove}
                    >
                        <Trash2 className="size-4" /> {t("fields.remove")}
                    </Button>
                </div>
            </div>

            <LabeledInput
                label={t("fields.nameLabel")}
                value={field.name}
                onChange={(value) => onChange({ name: value })}
                placeholder="greeting"
                error={errorFor(errors, `${path}.name`)}
            />

            {used ? null : (
                <p className="text-amber-600 text-xs dark:text-amber-500">
                    {t("fields.unused", { name: field.name })}
                </p>
            )}

            <FieldConfigFields
                field={field}
                path={path}
                errors={errors}
                onChange={onChange}
            />
        </div>
    );
}

/** The config controls for one member input (everything but its name). Shared with the args editor. */
export function FieldConfigFields({
    field,
    path,
    errors,
    onChange,
}: {
    field: FieldDraft;
    path: string;
    errors: string[];
    onChange: (patch: Partial<FieldDraft>) => void;
}) {
    const t = useTranslations("customTemplates");
    const requiredId = useId();
    // The options textarea isn't a LabeledInput, so it tracks its own touched state to match the
    // per-field "no error until touched" behavior.
    const [optionsTouched, setOptionsTouched] = useState(false);
    const isNumeric = NUMERIC_TYPES.includes(field.type);
    const allowsPattern = PATTERN_TYPES.includes(field.type);
    const showRequired = field.type !== "bool";
    const showDefault = field.type !== "bool" && field.type !== "json";

    const minError = errorFor(errors, `${path}.validation.min`);
    const maxError = errorFor(errors, `${path}.validation.max`);
    const patternError = errorFor(errors, `${path}.validation.pattern`);
    const defaultError = errorFor(errors, `${path}.default`);
    const advancedError = minError || maxError || patternError || defaultError;

    const [open, setOpen] = useState(() => hasAdvanced(field));
    const showAdvanced = open || Boolean(advancedError);

    function setDefault(text: string) {
        if (text.trim() === "") {
            onChange({ default: undefined });
            return;
        }
        if (field.type === "number") {
            const value = Number(text);
            // Keep the raw text when it isn't a number so the schema flags the mismatch.
            onChange({ default: Number.isNaN(value) ? text : value });
            return;
        }
        onChange({ default: text });
    }

    function setValidation(patch: Partial<FieldDraft["validation"]>) {
        onChange({ validation: { ...field.validation, ...patch } });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="grid gap-2 sm:grid-cols-2">
                <LabeledInput
                    label={t("fields.label")}
                    value={field.label}
                    onChange={(value) => onChange({ label: value })}
                    placeholder="Greeting"
                    error={errorFor(errors, `${path}.label`)}
                />
                <Labeled label={t("fields.typeLabel")}>
                    <Select
                        value={field.type}
                        onValueChange={(value) =>
                            // Clear default on a type switch (can't mismatch the new type), and clear
                            // `required` when moving to bool — it's not allowed there and there's no
                            // Required switch on a bool to clear it from.
                            onChange({
                                type: value as ManifestFieldType,
                                default: undefined,
                                ...(value === "bool"
                                    ? { required: false }
                                    : {}),
                            })
                        }
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {MANIFEST_FIELD_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                    {t(`fieldTypes.${type}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Labeled>
            </div>

            {showRequired ? (
                <div className="flex items-center gap-2">
                    <Switch
                        id={requiredId}
                        checked={field.required}
                        onCheckedChange={(checked) =>
                            onChange({ required: checked })
                        }
                    />
                    <Label htmlFor={requiredId} className="text-sm">
                        {t("fields.required")}
                    </Label>
                </div>
            ) : null}

            {field.type === "select" ? (
                <Labeled label={t("fields.optionsLabel")}>
                    <Textarea
                        rows={3}
                        className="font-mono text-xs"
                        value={field.options.join("\n")}
                        aria-invalid={
                            optionsTouched &&
                            errorFor(errors, `${path}.options`)
                                ? true
                                : undefined
                        }
                        onBlur={() => setOptionsTouched(true)}
                        onChange={(event) =>
                            onChange({
                                options: event.target.value
                                    .split("\n")
                                    .map((line) => line.trim())
                                    .filter(Boolean),
                            })
                        }
                        placeholder={"option-a\noption-b"}
                    />
                    <FieldError
                        message={
                            optionsTouched
                                ? errorFor(errors, `${path}.options`)
                                : undefined
                        }
                    />
                </Labeled>
            ) : null}

            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className="flex items-center gap-1 self-start text-muted-foreground text-xs transition-colors hover:text-foreground"
            >
                {showAdvanced ? (
                    <ChevronUp className="size-3.5" />
                ) : (
                    <ChevronDown className="size-3.5" />
                )}
                {t("fields.advancedOptions")}
            </button>

            {showAdvanced ? (
                <div className="flex flex-col gap-3 border-t pt-3">
                    <LabeledInput
                        label={t("fields.helpLabel")}
                        value={field.help}
                        onChange={(value) => onChange({ help: value })}
                        placeholder={t("fields.helpPlaceholder")}
                    />

                    {isNumeric ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <LabeledInput
                                label={t("fields.minLabel")}
                                value={field.validation.min}
                                onChange={(value) =>
                                    setValidation({ min: value })
                                }
                                placeholder="0"
                                error={minError}
                            />
                            <LabeledInput
                                label={t("fields.maxLabel")}
                                value={field.validation.max}
                                onChange={(value) =>
                                    setValidation({ max: value })
                                }
                                error={maxError}
                            />
                        </div>
                    ) : null}

                    {allowsPattern ? (
                        <LabeledInput
                            label={t("fields.patternLabel")}
                            value={field.validation.pattern}
                            onChange={(value) =>
                                setValidation({ pattern: value })
                            }
                            placeholder="^[A-Za-z]"
                            error={patternError}
                        />
                    ) : null}

                    {showDefault ? (
                        <LabeledInput
                            label={t("fields.defaultLabel")}
                            value={String(field.default ?? "")}
                            onChange={setDefault}
                            error={defaultError}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export function LabeledInput({
    label,
    value,
    onChange,
    placeholder,
    error,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    error?: string;
}) {
    // Show this field's error only after the user has touched it (blurred once), so an untouched
    // field never reds — even while other fields in the form are invalid.
    const [touched, setTouched] = useState(false);
    const shownError = touched ? error : undefined;
    return (
        <Labeled label={label}>
            <Input
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder={placeholder}
                aria-invalid={shownError ? true : undefined}
            />
            <FieldError message={shownError} />
        </Labeled>
    );
}

export function FieldError({ message }: { message?: string }) {
    if (!message) {
        return null;
    }
    return <p className="text-destructive text-xs">{message}</p>;
}

export function Labeled({
    label,
    className,
    action,
    children,
}: {
    label: string;
    className?: string;
    /** Optional control rendered at the top-right of the label row (e.g. an inline "+ field" link). */
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className={cn("flex flex-col gap-1", className)}>
            {/* Fixed height so a label row with an action (e.g. the "+ field" link) stays the same
                height as one without — otherwise paired grid cells misalign their inputs. */}
            <div className="flex h-5 items-center justify-between gap-2">
                <Label className="text-muted-foreground text-xs">{label}</Label>
                {action}
            </div>
            {children}
        </div>
    );
}

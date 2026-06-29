"use client";

/**
 * Args-first editor: each argument is the unit. A top-level argument is **Static** (a fixed value —
 * text/number/bool/null/object/array, `{{field}}` allowed in text) or **Dynamic** (a member input),
 * in which case its value is `{{key}}` and the row expands to that input's config inline (the field
 * named `key`). Renaming a dynamic key renames its field too, so args + fields update atomically via
 * one `onChange({ args, fields })`. Nested object/array values are static-only here; a member input
 * inside them is a composed `{{placeholder}}` configured under "Other inputs".
 */
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { Button } from "@/components/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
    ARG_VALUE_TYPES,
    type ArgValueType,
    changeType,
    emptyNodeOf,
    isDynamicArg,
    valueTypeOf,
} from "../args-node";
import {
    type ArgEntry,
    type ArgItem,
    type ArgNode,
    type FieldDraft,
    makeArgEntry,
    makeArgItem,
} from "../draft";
import { errorFor } from "../error-map";
import { FieldConfigFields, Labeled, LabeledInput } from "./fields-builder";

/** Static value kinds — "field" is excluded (a direct member input is the Dynamic mode instead). */
const STATIC_TYPES: ArgValueType[] = ARG_VALUE_TYPES.filter(
    (type) => type !== "field",
);

/** The static value-type to display for a node (a lone placeholder reads as plain text here). */
function staticTypeOf(node: ArgNode): ArgValueType {
    const inferred = valueTypeOf(node);
    return inferred === "field" ? "text" : inferred;
}

interface ArgsTreeEditorProps {
    args: ArgEntry[];
    fields: FieldDraft[];
    fieldNames: string[];
    errors: string[];
    onChange: (next: { args: ArgEntry[]; fields: FieldDraft[] }) => void;
}

/** Top-level args editor — entries carry the Static/Dynamic choice. */
export function ArgsTreeEditor({
    args,
    fields,
    fieldNames,
    errors,
    onChange,
}: ArgsTreeEditorProps) {
    const t = useTranslations("customTemplates");
    return (
        <div className="flex flex-col gap-4">
            {args.map((entry, index) => (
                <Fragment key={entry.id}>
                    {index > 0 ? <Separator /> : null}
                    <TopEntryRow
                        args={args}
                        index={index}
                        fields={fields}
                        fieldNames={fieldNames}
                        errors={errors}
                        onChange={onChange}
                    />
                </Fragment>
            ))}
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={() =>
                    onChange({ args: [...args, makeArgEntry()], fields })
                }
            >
                <Plus className="size-4" /> {t("args.addArgument")}
            </Button>
        </div>
    );
}

interface TopEntryRowProps {
    args: ArgEntry[];
    index: number;
    fields: FieldDraft[];
    fieldNames: string[];
    errors: string[];
    onChange: (next: { args: ArgEntry[]; fields: FieldDraft[] }) => void;
}

function TopEntryRow({
    args,
    index,
    fields,
    fieldNames,
    errors,
    onChange,
}: TopEntryRowProps) {
    const t = useTranslations("customTemplates");
    const entry = args[index];
    const dynamic = isDynamicArg(entry);
    const fieldIndex = fields.findIndex((field) => field.name === entry.key);
    const field = fields[fieldIndex];
    // For a dynamic arg the key *is* the field name, so a `field.name` validation error (e.g. a
    // space or other non-identifier char) has no input of its own — surface it on the key input.
    const keyError = dynamic
        ? errorFor(errors, `fields.${fieldIndex}.name`)
        : undefined;
    // A lone static string value can have a `{{field}}` placeholder appended via the inline inserter.
    const staticStringValue =
        entry.value.kind === "string" ? entry.value.value : null;

    const setArgs = (next: ArgEntry[]) => onChange({ args: next, fields });
    const replace = (next: ArgEntry) =>
        setArgs(args.map((existing, i) => (i === index ? next : existing)));

    function setKey(key: string) {
        if (dynamic) {
            // Rename the field with the key and re-point the placeholder — atomically.
            onChange({
                args: args.map((existing, i) =>
                    i === index
                        ? {
                              ...existing,
                              key,
                              value: { kind: "string", value: `{{${key}}}` },
                          }
                        : existing,
                ),
                fields: fields.map((candidate) =>
                    candidate.name === entry.key
                        ? { ...candidate, name: key }
                        : candidate,
                ),
            });
            return;
        }
        replace({ ...entry, key });
    }

    function setDynamic(next: boolean) {
        if (next) {
            // Value becomes {{key}}; normalizeFields (at the top) creates the field.
            replace({
                ...entry,
                value: { kind: "string", value: `{{${entry.key}}}` },
            });
            return;
        }
        replace({ ...entry, value: { kind: "string", value: "" } });
    }

    function setStaticType(type: ArgValueType) {
        replace({ ...entry, value: changeType(entry.value, type, fieldNames) });
    }

    function setValue(value: ArgNode) {
        replace({ ...entry, value });
    }

    function setFieldConfig(patch: Partial<FieldDraft>) {
        onChange({
            args,
            fields: fields.map((candidate, i) =>
                i === fieldIndex ? { ...candidate, ...patch } : candidate,
            ),
        });
    }

    function removeEntry() {
        // A dynamic arg owns its field (name == key) — drop both so it can't linger in Other inputs.
        onChange({
            args: args.filter((_, i) => i !== index),
            fields: dynamic
                ? fields.filter((candidate) => candidate.name !== entry.key)
                : fields,
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <h4 className="font-semibold text-sm">
                    {t("args.argumentHeading", { number: index + 1 })}
                </h4>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={removeEntry}
                >
                    <Trash2 className="size-4" /> {t("args.remove")}
                </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
                <LabeledInput
                    label={t("args.argumentNameLabel")}
                    value={entry.key}
                    onChange={setKey}
                    placeholder={t("args.argumentNamePlaceholder")}
                    error={keyError}
                />
                <Labeled label={t("args.typeLabel")}>
                    <Select
                        value={dynamic ? "dynamic" : "static"}
                        onValueChange={(value) =>
                            setDynamic(value === "dynamic")
                        }
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="static">
                                {t("args.modeStatic")}
                            </SelectItem>
                            <SelectItem
                                value="dynamic"
                                disabled={entry.key === ""}
                            >
                                {t("args.modeMemberInput")}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </Labeled>
            </div>

            {dynamic && field ? (
                <FieldConfigFields
                    field={field}
                    path={`fields.${fieldIndex}`}
                    errors={errors}
                    onChange={setFieldConfig}
                />
            ) : null}

            {!dynamic ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <Labeled label={t("args.valueTypeLabel")}>
                        <Select
                            value={staticTypeOf(entry.value)}
                            onValueChange={(value) =>
                                setStaticType(value as ArgValueType)
                            }
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {STATIC_TYPES.map((staticType) => (
                                    <SelectItem
                                        key={staticType}
                                        value={staticType}
                                    >
                                        {staticType}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Labeled>
                    <Labeled
                        label={t("args.valueLabel")}
                        action={
                            staticStringValue !== null &&
                            fieldNames.length > 0 ? (
                                <FieldInserter
                                    fieldNames={fieldNames}
                                    onInsert={(name) =>
                                        setValue({
                                            kind: "string",
                                            value: `${staticStringValue}{{${name}}}`,
                                        })
                                    }
                                />
                            ) : undefined
                        }
                    >
                        <StaticLeaf
                            node={entry.value}
                            fieldNames={[]}
                            onChange={setValue}
                        />
                    </Labeled>
                </div>
            ) : null}

            {!dynamic && entry.value.kind === "object" ? (
                <StaticEntriesEditor
                    entries={entry.value.entries}
                    fieldNames={fieldNames}
                    onChange={(entries) =>
                        setValue({ kind: "object", entries })
                    }
                />
            ) : null}
            {!dynamic && entry.value.kind === "array" ? (
                <StaticItemsEditor
                    items={entry.value.items}
                    fieldNames={fieldNames}
                    onChange={(items) => setValue({ kind: "array", items })}
                />
            ) : null}
        </div>
    );
}

/** Static value editor: a type dropdown + the matching inline control (object/array nest below). */
function StaticValue({
    type,
    node,
    fieldNames,
    onTypeChange,
    onChange,
}: {
    type: ArgValueType;
    node: ArgNode;
    fieldNames: string[];
    onTypeChange: (type: ArgValueType) => void;
    onChange: (node: ArgNode) => void;
}) {
    return (
        <div className="flex flex-1 items-center gap-2">
            <Select
                value={type}
                onValueChange={(value) => onTypeChange(value as ArgValueType)}
            >
                <SelectTrigger className="w-24 shrink-0">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {STATIC_TYPES.map((staticType) => (
                        <SelectItem key={staticType} value={staticType}>
                            {staticType}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <StaticLeaf
                node={node}
                fieldNames={fieldNames}
                onChange={onChange}
            />
        </div>
    );
}

/** The scalar editor for a static value (object/array carry no inline control — they nest). */
function StaticLeaf({
    node,
    fieldNames,
    onChange,
}: {
    node: ArgNode;
    fieldNames: string[];
    onChange: (node: ArgNode) => void;
}) {
    const t = useTranslations("customTemplates");
    if (node.kind === "string") {
        return (
            <div className="flex flex-1 items-center gap-2">
                <Input
                    className="flex-1 font-mono text-xs"
                    value={node.value}
                    onChange={(event) =>
                        onChange({ kind: "string", value: event.target.value })
                    }
                    placeholder={t("args.stringValuePlaceholder")}
                />
                {fieldNames.length > 0 ? (
                    <FieldInserter
                        fieldNames={fieldNames}
                        onInsert={(name) =>
                            onChange({
                                kind: "string",
                                value: `${node.value}{{${name}}}`,
                            })
                        }
                    />
                ) : null}
            </div>
        );
    }
    if (node.kind === "number") {
        return (
            <Input
                type="number"
                className="flex-1"
                value={String(node.value)}
                onChange={(event) =>
                    onChange({
                        kind: "number",
                        value: Number(event.target.value),
                    })
                }
            />
        );
    }
    if (node.kind === "boolean") {
        return (
            <Switch
                checked={node.value}
                onCheckedChange={(checked) =>
                    onChange({ kind: "boolean", value: checked })
                }
            />
        );
    }
    // null / object / array carry no inline editor.
    return <div className="flex-1" />;
}

/** Inline link-style dropdown (top-right of the Value label) that appends a `{{field}}` placeholder. */
function FieldInserter({
    fieldNames,
    onInsert,
}: {
    fieldNames: string[];
    onInsert: (name: string) => void;
}) {
    const t = useTranslations("customTemplates");
    return (
        <Select value="" onValueChange={onInsert}>
            <SelectTrigger className="h-auto w-auto gap-1 border-0 bg-transparent p-0 text-muted-foreground text-xs shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-0">
                {t("args.insertField")}
            </SelectTrigger>
            <SelectContent>
                {fieldNames.map((name) => (
                    <SelectItem key={name} value={name}>
                        {name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/** Static key→value entries inside a nested object (no Dynamic here — use a composed placeholder). */
function StaticEntriesEditor({
    entries,
    fieldNames,
    onChange,
}: {
    entries: ArgEntry[];
    fieldNames: string[];
    onChange: (entries: ArgEntry[]) => void;
}) {
    const t = useTranslations("customTemplates");
    return (
        <div className="flex flex-col gap-2 border-l pl-3">
            {entries.map((entry, index) => (
                <div key={entry.id} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <Input
                            className="w-40 shrink-0"
                            value={entry.key}
                            onChange={(event) =>
                                onChange(
                                    entries.map((existing, i) =>
                                        i === index
                                            ? {
                                                  ...existing,
                                                  key: event.target.value,
                                              }
                                            : existing,
                                    ),
                                )
                            }
                            placeholder={t("args.keyPlaceholder")}
                        />
                        <StaticValue
                            type={staticTypeOf(entry.value)}
                            node={entry.value}
                            fieldNames={fieldNames}
                            onTypeChange={(type) =>
                                onChange(
                                    entries.map((existing, i) =>
                                        i === index
                                            ? {
                                                  ...existing,
                                                  value: changeType(
                                                      existing.value,
                                                      type,
                                                      fieldNames,
                                                  ),
                                              }
                                            : existing,
                                    ),
                                )
                            }
                            onChange={(value) =>
                                onChange(
                                    entries.map((existing, i) =>
                                        i === index
                                            ? { ...existing, value }
                                            : existing,
                                    ),
                                )
                            }
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() =>
                                onChange(entries.filter((_, i) => i !== index))
                            }
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                    {entry.value.kind === "object" ? (
                        <StaticEntriesEditor
                            entries={entry.value.entries}
                            fieldNames={fieldNames}
                            onChange={(nested) =>
                                onChange(
                                    entries.map((existing, i) =>
                                        i === index
                                            ? {
                                                  ...existing,
                                                  value: {
                                                      kind: "object",
                                                      entries: nested,
                                                  },
                                              }
                                            : existing,
                                    ),
                                )
                            }
                        />
                    ) : null}
                    {entry.value.kind === "array" ? (
                        <StaticItemsEditor
                            items={entry.value.items}
                            fieldNames={fieldNames}
                            onChange={(nested) =>
                                onChange(
                                    entries.map((existing, i) =>
                                        i === index
                                            ? {
                                                  ...existing,
                                                  value: {
                                                      kind: "array",
                                                      items: nested,
                                                  },
                                              }
                                            : existing,
                                    ),
                                )
                            }
                        />
                    ) : null}
                </div>
            ))}
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => onChange([...entries, makeArgEntry()])}
            >
                <Plus className="size-4" /> {t("args.addKey")}
            </Button>
        </div>
    );
}

/** Static array items (all static). New items match the last item's kind. */
function StaticItemsEditor({
    items,
    fieldNames,
    onChange,
}: {
    items: ArgItem[];
    fieldNames: string[];
    onChange: (items: ArgItem[]) => void;
}) {
    const t = useTranslations("customTemplates");
    function addItem() {
        const last = items.at(-1)?.value;
        const seed = last
            ? emptyNodeOf(staticTypeOf(last), fieldNames)
            : { kind: "string" as const, value: "" };
        onChange([...items, makeArgItem(seed)]);
    }

    return (
        <div className="flex flex-col gap-2 border-l pl-3">
            {items.map((item, index) => (
                <div key={item.id} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <span className="w-6 shrink-0 text-muted-foreground text-xs">
                            {index}
                        </span>
                        <StaticValue
                            type={staticTypeOf(item.value)}
                            node={item.value}
                            fieldNames={fieldNames}
                            onTypeChange={(type) =>
                                onChange(
                                    items.map((existing, i) =>
                                        i === index
                                            ? {
                                                  ...existing,
                                                  value: changeType(
                                                      existing.value,
                                                      type,
                                                      fieldNames,
                                                  ),
                                              }
                                            : existing,
                                    ),
                                )
                            }
                            onChange={(value) =>
                                onChange(
                                    items.map((existing, i) =>
                                        i === index
                                            ? { ...existing, value }
                                            : existing,
                                    ),
                                )
                            }
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() =>
                                onChange(items.filter((_, i) => i !== index))
                            }
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                </div>
            ))}
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={addItem}
            >
                <Plus className="size-4" /> {t("args.addItem")}
            </Button>
        </div>
    );
}

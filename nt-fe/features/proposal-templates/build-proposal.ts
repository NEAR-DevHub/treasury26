/**
 * Template engine for the custom-proposal framework: turn a validated manifest plus the values a
 * member filled in the rendered form into the exact SputnikDAO `FunctionCall` proposal — `kind` +
 * `description` — that `createProposal` (stores/near-store) submits.
 *
 * Pure and framework-free, so it unit-tests without React or a wallet, and it reuses the manifest
 * module's `substitutePlaceholders` so the args it emits can never drift from what the validator
 * checked. Two distinct rules govern the `args` tree:
 *   (1) A value that is exactly one placeholder — `"{{field}}"` and nothing else — resolves to that
 *       field's *typed* JSON: a `bool` field yields a real boolean, `number` a real number, and
 *       `json` the parsed value, so a contract's serde accepts them. Every other type (notably the
 *       u128 `uint`/`amount`, which must stay digit strings) and any *composed* string
 *       (`"{{a}}/{{b}}"`, or a field embedded in a JSON string) stays a string.
 *   (2) Any static non-string node in the template — a number, boolean, or nested object/array
 *       literal — passes through verbatim, keeping its JSON type.
 * So a member-filled `bool`/`number`/`json` lands typed; everything else, and all composition, is
 * string — and amounts never round-trip through a JS number.
 */
import type { FunctionCallKind } from "@/lib/proposals-api";
import { encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import {
    type Manifest,
    type ManifestFieldType,
    substitutePlaceholders,
} from "./manifest";

/** Values a member filled, keyed by field `name`. */
export type FieldValues = Record<string, unknown>;

/** The on-chain proposal a template produces: a `FunctionCall` kind and its description. */
export interface TemplateProposal {
    kind: FunctionCallKind;
    description: string;
}

/** Coerce a field value into the string that replaces its `{{placeholder}}`. */
function resolveValue(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    // A `json` field's object/array value injects its JSON text (e.g. a stringified `msg`).
    return JSON.stringify(value);
}

/** Interpolate `{{field}}` placeholders in a single string — the one path both args and summary use. */
function interpolateString(text: string, values: FieldValues): string {
    return substitutePlaceholders(text, (name) => resolveValue(values[name]));
}

// A value that is exactly one placeholder — `{{name}}` and nothing else. The `{{{{x}}}}` escape
// (four braces) can't match (its inner `{` isn't a name char), so an escaped literal never triggers
// typed resolution; only a genuine lone reference does.
const LONE_PLACEHOLDER_RE = /^\{\{([a-zA-Z0-9_]+)\}\}$/;

/**
 * If `text` is a lone `{{field}}` for a `bool`/`number`/`json` field, return its typed JSON value
 * (boxed, since the value itself may legitimately be `false`/`0`/`null`). Returns `null` to defer to
 * the normal string path — for every other type, for composed strings, and when a `number`/`json`
 * value is empty or unparseable (don't coerce `""` → `0` or crash on bad JSON).
 */
function typedLoneValue(
    text: string,
    values: FieldValues,
    fieldTypes: Map<string, ManifestFieldType>,
): { value: unknown } | null {
    const match = LONE_PLACEHOLDER_RE.exec(text);
    if (!match) {
        return null;
    }
    const raw = values[match[1]];
    switch (fieldTypes.get(match[1])) {
        case "bool":
            return { value: typeof raw === "boolean" ? raw : raw === "true" };
        case "number":
            if (typeof raw === "number") {
                return { value: raw };
            }
            if (
                typeof raw === "string" &&
                raw.trim() !== "" &&
                Number.isFinite(Number(raw))
            ) {
                return { value: Number(raw) };
            }
            return null;
        case "json":
            if (typeof raw === "string" && raw.trim() !== "") {
                try {
                    return { value: JSON.parse(raw) };
                } catch {
                    return null;
                }
            }
            return null;
        default:
            return null;
    }
}

/**
 * Recursively interpolate `{{field}}` placeholders through an args template using `values`. With
 * `fieldTypes`, a lone `{{field}}` for a `bool`/`number`/`json` field resolves to its typed JSON
 * (see `typedLoneValue`); without it, every placeholder is stringified (used for the summary line).
 */
export function interpolateArgs(
    template: unknown,
    values: FieldValues,
    fieldTypes?: Map<string, ManifestFieldType>,
): unknown {
    if (typeof template === "string") {
        if (fieldTypes) {
            const typed = typedLoneValue(template, values, fieldTypes);
            if (typed) {
                return typed.value;
            }
        }
        return interpolateString(template, values);
    }
    if (Array.isArray(template)) {
        return template.map((item) =>
            interpolateArgs(item, values, fieldTypes),
        );
    }
    if (template !== null && typeof template === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(template)) {
            out[key] = interpolateArgs(item, values, fieldTypes);
        }
        return out;
    }
    return template;
}

/**
 * Build the `{ kind, description }` an authored `manifest` and a member's `values` produce.
 *
 * The description carries the `[trezu-tmpl:<id>]` tag so a created proposal is traceable back to
 * the template that minted it (the manifest `id` is constrained to a tag-safe slug for exactly
 * this). `deposit`/`gas` come verbatim from the manifest `binding` (digit strings, never numbers).
 */
export function buildTemplateProposal(
    manifest: Manifest,
    values: FieldValues,
): TemplateProposal {
    const fieldTypes = new Map(
        manifest.fields.map((field) => [field.name, field.type]),
    );
    const args = interpolateArgs(manifest.args, values, fieldTypes);
    const kind: FunctionCallKind = {
        FunctionCall: {
            receiver_id: manifest.binding.receiver_id,
            actions: [
                {
                    method_name: manifest.binding.method_name,
                    args: jsonToBase64(args),
                    deposit: manifest.binding.deposit,
                    gas: manifest.binding.gas,
                },
            ],
        },
    };

    const summary = manifest.summary
        ? interpolateString(manifest.summary, values)
        : manifest.title;
    const description = encodeToMarkdown({
        proposal_action: "custom",
        template: `[trezu-tmpl:${manifest.id}]`,
        summary,
    });

    return { kind, description };
}

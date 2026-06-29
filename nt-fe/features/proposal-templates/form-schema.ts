/**
 * Derive a react-hook-form validation schema — and matching initial values — from a validated
 * manifest, so the rendered form checks each field by its declared `type`, `required` flag, and
 * `validation` rules before the engine ever builds a proposal. Pure (no React), so the
 * field-type -> validator mapping unit-tests in isolation, like the engine.
 *
 * Form value representation: every field is a string in form state except `bool` (a real boolean).
 * Amounts therefore stay strings and are bound-checked with `Big`, never a JS number, so u128
 * limits hold past 2^53. Empty string means "not filled" — only a `required` field rejects it.
 */

import { z } from "zod";
import Big from "@/lib/big";
import type { FieldValues } from "./build-proposal";
import { type Manifest, type ManifestField, NEAR_ACCOUNT_RE } from "./manifest";

const INTEGER_RE = /^\d+$/;

/**
 * Wrap a check so an empty (unfilled) value passes; `required` is enforced separately. Accepts
 * `unknown` because later refines run on a widened (`z.ZodTypeAny`) schema whose value type is no
 * longer `string`; the `typeof` guard narrows it back before the inner check.
 */
const allowEmpty =
    (check: (value: string) => boolean) =>
    (value: unknown): boolean =>
        typeof value !== "string" || value === "" || check(value);

function isParseableJson(value: string): boolean {
    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

// A field's `validation.pattern` is an author-supplied regex run client-side as the member types.
// Bounding the input length fed to `.test` limits catastrophic-backtracking (ReDoS) blow-up — input
// length is the lever that turns an accidentally bad pattern into a frozen tab. Pattern length is
// capped at parse time (manifest.ts); real pattern-validated fields (codes, ids) are short anyway.
const MAX_PATTERN_INPUT = 256;

function safeRegExp(pattern: string): RegExp | null {
    try {
        return new RegExp(pattern);
    } catch {
        return null;
    }
}

/** Whether a non-empty value matches the field's `type`. */
function passesType(field: ManifestField, value: string): boolean {
    switch (field.type) {
        case "account":
            return NEAR_ACCOUNT_RE.test(value);
        case "uint":
        case "amount":
            return INTEGER_RE.test(value);
        case "number":
            return Number.isFinite(Number(value));
        case "select":
            return (field.options ?? []).includes(value);
        case "json":
            return isParseableJson(value);
        default:
            // token, text: any non-empty string is accepted.
            return true;
    }
}

/**
 * Member-facing validation messages, injected so they stay localized: next-intl strings live in the
 * UI layer, while this module stays pure (no React, no next-intl). `label` is the field's authored
 * label; `min`/`max` the configured bound.
 */
export interface ValidationMessages {
    required: (label: string) => string;
    account: (label: string) => string;
    wholeNumber: (label: string) => string;
    number: (label: string) => string;
    select: (label: string) => string;
    json: (label: string) => string;
    invalid: (label: string) => string;
    pattern: (label: string) => string;
    min: (label: string, min: string) => string;
    max: (label: string, max: string) => string;
}

function typeMessage(
    field: ManifestField,
    messages: ValidationMessages,
): string {
    switch (field.type) {
        case "account":
            return messages.account(field.label);
        case "uint":
        case "amount":
            return messages.wholeNumber(field.label);
        case "number":
            return messages.number(field.label);
        case "select":
            return messages.select(field.label);
        case "json":
            return messages.json(field.label);
        default:
            return messages.invalid(field.label);
    }
}

/** Numeric bound check via Big; a non-numeric value just skips (its type check already failed). */
function meetsBound(value: string, bound: string, atLeast: boolean): boolean {
    try {
        const cmp = Big(value).cmp(Big(bound));
        return atLeast ? cmp >= 0 : cmp <= 0;
    } catch {
        return true;
    }
}

function fieldValueSchema(
    field: ManifestField,
    messages: ValidationMessages,
): z.ZodTypeAny {
    if (field.type === "bool") {
        return z.boolean();
    }

    const required = field.required === true;
    let schema: z.ZodTypeAny = z
        .string()
        .refine((value) => value !== "" || !required, {
            message: messages.required(field.label),
        })
        .refine(
            allowEmpty((value) => passesType(field, value)),
            {
                message: typeMessage(field, messages),
            },
        );

    const pattern = field.validation?.pattern
        ? safeRegExp(field.validation.pattern)
        : null;
    if (pattern) {
        schema = schema.refine(
            allowEmpty(
                (value) =>
                    value.length <= MAX_PATTERN_INPUT && pattern.test(value),
            ),
            {
                message: messages.pattern(field.label),
            },
        );
    }

    const min = field.validation?.min;
    if (min !== undefined) {
        schema = schema.refine(
            allowEmpty((value) => meetsBound(value, min, true)),
            { message: messages.min(field.label, min) },
        );
    }

    const max = field.validation?.max;
    if (max !== undefined) {
        schema = schema.refine(
            allowEmpty((value) => meetsBound(value, max, false)),
            { message: messages.max(field.label, max) },
        );
    }

    return schema;
}

/** Build the react-hook-form zod schema that validates a manifest's filled values. */
export function buildFormSchema(
    manifest: Manifest,
    messages: ValidationMessages,
) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const field of manifest.fields) {
        shape[field.name] = fieldValueSchema(field, messages);
    }
    return z.object(shape);
}

/** A field's `default` coerced to its form representation (string state, except `bool`). */
function defaultValueFor(field: ManifestField): unknown {
    if (field.type === "bool") {
        return typeof field.default === "boolean" ? field.default : false;
    }
    if (field.default === undefined) {
        return "";
    }
    if (typeof field.default === "string") {
        return field.default;
    }
    // A `number` default (e.g. 5) -> "5"; a `json` default (object) -> its JSON text.
    return field.type === "json"
        ? JSON.stringify(field.default)
        : String(field.default);
}

/** Initial form values: each field's coerced `default`, else a type-appropriate empty. */
export function defaultValuesFor(manifest: Manifest): FieldValues {
    const values: FieldValues = {};
    for (const field of manifest.fields) {
        values[field.name] = defaultValueFor(field);
    }
    return values;
}

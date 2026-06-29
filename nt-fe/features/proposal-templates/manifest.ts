/**
 * Manifest schema for the custom-proposal framework (frontend source of truth).
 *
 * A *manifest* is a JSON form definition: a techy DAO member authors it, regular members fill the
 * rendered form to file a generic SputnikDAO `FunctionCall` proposal. This module is the single
 * validated shape both the authoring UI (validate before save) and the form engine (interpret the
 * fields) build on.
 *
 * It mirrors — and deliberately extends — the backend `validate_manifest` (nt-be
 * `handlers/proposal_templates.rs`): the backend enforces only the structural shape and stores a
 * normalized copy, while this validator additionally (a) checks each field's `type`, (b) requires
 * the amount strings `binding.deposit`/`gas` and per-field `validation.min`/`max` to be digit
 * strings, and (c) cross-checks that every `{{field}}` placeholder in `args`/`summary` is declared
 * in `fields`. A manifest that passes here therefore also passes the backend.
 *
 * u128 safety: those amount strings are validated as digit strings, never `number`, so NEAR
 * amounts (which exceed 2^53) survive untruncated.
 */
import { z } from "zod";

/** Field input types a manifest may declare; each maps to a trezu form component. */
export const MANIFEST_FIELD_TYPES = [
    "account",
    "token",
    "uint",
    "amount",
    "text",
    "number",
    "select",
    "bool",
    "json",
] as const;

export const manifestFieldTypeSchema = z.enum(MANIFEST_FIELD_TYPES);
export type ManifestFieldType = z.infer<typeof manifestFieldTypeSchema>;

const nonBlankString = (label: string) =>
    z.string().trim().min(1, `${label} must not be blank`);

const INTEGER_RE = /^\d+$/;

const integerString = (label: string) =>
    z.string().regex(INTEGER_RE, `${label} must be an integer string`);

// The manifest id is wrapped in the `[trezu-tmpl:<id>]` description tag, so it must be tag-safe.
const TAG_SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Slugs reserved for static routes under `/custom-templates/` — a template id can't claim one, or
 * its `/custom-templates/<id>` page would be shadowed by the static route and become unreachable.
 * Keep this in sync with the backend `validate_manifest` reserved list.
 */
export const RESERVED_TEMPLATE_SLUGS = ["create", "new", "about"];

const tagSafeId = z
    .string()
    .trim()
    .regex(
        TAG_SAFE_ID_RE,
        "id must be a tag-safe slug ([A-Za-z0-9_-]) so the [trezu-tmpl:<id>] tag stays parseable",
    )
    .refine((id) => !RESERVED_TEMPLATE_SLUGS.includes(id.toLowerCase()), {
        message: `id must not be a reserved route slug (${RESERVED_TEMPLATE_SLUGS.join(", ")})`,
    });

// Field names must match the {{placeholder}} charset, so every field is referenceable from args.
const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/;
const fieldName = z
    .string()
    .trim()
    .regex(
        FIELD_NAME_RE,
        "field.name must be a {{placeholder}}-safe identifier ([A-Za-z0-9_])",
    );

// `binding.receiver_id`/`method_name` go straight into the on-chain FunctionCall, so they must be a
// real account and a real method — not free text. Without this, "I m the receiver" / "the method"
// pass and the template files an un-callable proposal. The account rule is shared with the `account`
// field type (form-schema imports NEAR_ACCOUNT_RE) so the two can't drift.
export const NEAR_ACCOUNT_RE =
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const nearAccountString = (label: string) =>
    nonBlankString(label).regex(
        NEAR_ACCOUNT_RE,
        `${label} must be a valid NEAR account id (lowercase, e.g. usdc.near)`,
    );

// Contract method names are identifiers in practice (ft_transfer, set_greeting); reject whitespace
// and other free text that could never name a real method.
const METHOD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const methodNameString = (label: string) =>
    nonBlankString(label).regex(
        METHOD_NAME_RE,
        `${label} must be a valid contract method name ([A-Za-z0-9_], no spaces)`,
    );

// Cap an author-supplied pattern's source length. The pattern is compiled and run client-side as
// members type, so an overlong one is both a likely mistake and a catastrophic-backtracking (ReDoS)
// lever; no legitimate field constraint needs more. Pairs with the input-length cap in form-schema.
const MAX_PATTERN_LENGTH = 200;

/** Whether `pattern` compiles as a regex — a typo'd pattern must fail authoring, not drop silently. */
function isValidRegExp(pattern: string): boolean {
    try {
        return new RegExp(pattern) instanceof RegExp;
    } catch {
        return false;
    }
}

/** Optional per-field constraints. min/max are digit strings to stay u128/BigInt-safe. */
export const manifestFieldValidationSchema = z
    .object({
        min: integerString("validation.min").optional(),
        max: integerString("validation.max").optional(),
        pattern: z
            .string()
            .max(
                MAX_PATTERN_LENGTH,
                `validation.pattern must be at most ${MAX_PATTERN_LENGTH} characters`,
            )
            .optional(),
    })
    .refine(
        (validation) =>
            validation.pattern === undefined ||
            isValidRegExp(validation.pattern),
        {
            message: "validation.pattern is not a valid regular expression",
            path: ["pattern"],
        },
    );

const manifestFieldBase = z.object({
    name: fieldName,
    label: nonBlankString("field.label"),
    type: manifestFieldTypeSchema,
    required: z.boolean().optional(),
    // zod v4: z.unknown() accepts a missing key, so no `.optional()` is needed (the key may be
    // omitted entirely); its shape is tied to `type` by the refinements below, not left arbitrary.
    default: z.unknown(),
    help: z.string().optional(),
    /** Choices for a `select` field (required there, forbidden elsewhere). */
    options: z.array(z.string()).optional(),
    validation: manifestFieldValidationSchema.optional(),
});

type ManifestFieldBase = z.infer<typeof manifestFieldBase>;

/** `options` is required for `select` and forbidden on every other type. */
function optionsMatchType(field: ManifestFieldBase): boolean {
    return field.type === "select"
        ? Array.isArray(field.options) && field.options.length > 0
        : field.options === undefined;
}

/** `validation.pattern` (a regex) only applies to free-text inputs. */
function patternMatchesType(field: ManifestFieldBase): boolean {
    return (
        field.validation?.pattern === undefined ||
        field.type === "text" ||
        field.type === "number"
    );
}

/** A field's `default`, when present, must match its declared `type`. */
function defaultMatchesType(field: ManifestFieldBase): boolean {
    const value = field.default;
    if (value === undefined) {
        return true;
    }
    switch (field.type) {
        case "account":
        case "token":
        case "text":
            // A provided default must be meaningful, not empty ("" == no default).
            return typeof value === "string" && value.length > 0;
        case "uint":
        case "amount":
            return typeof value === "string" && INTEGER_RE.test(value);
        case "number":
            return typeof value === "number";
        case "bool":
            return typeof value === "boolean";
        case "select":
            // `options` is not guaranteed here: zod runs every refine, so a `select` field
            // missing `options` still reaches this branch even though `optionsMatchType` flagged
            // it — dropping the guard would throw on `{ type: 'select', default: 'x' }`.
            return (
                typeof value === "string" &&
                (field.options ?? []).includes(value)
            );
        case "json":
            // json defaults are opaque — z.unknown() already admits any value, nothing to check.
            return true;
        default:
            return false;
    }
}

/** `validation.min`/`max` (numeric bounds) only apply to numeric fields. */
function boundsMatchType(field: ManifestFieldBase): boolean {
    const hasBound =
        field.validation?.min !== undefined ||
        field.validation?.max !== undefined;
    return (
        !hasBound ||
        field.type === "uint" ||
        field.type === "amount" ||
        field.type === "number"
    );
}

/** `required` is meaningless on a `bool` (a toggle always submits true or false). */
function requiredAllowed(field: ManifestFieldBase): boolean {
    return !(field.type === "bool" && field.required === true);
}

export const manifestFieldSchema = manifestFieldBase
    .refine(optionsMatchType, {
        message:
            "`options` is required for a `select` field and forbidden otherwise",
        path: ["options"],
    })
    .refine(patternMatchesType, {
        message:
            "`validation.pattern` is only valid on `text` or `number` fields",
        path: ["validation", "pattern"],
    })
    .refine(boundsMatchType, {
        message:
            "`validation.min`/`max` are only valid on numeric fields (uint, amount, number)",
        path: ["validation"],
    })
    .refine(requiredAllowed, {
        message: "`required` has no meaning on a `bool` field",
        path: ["required"],
    })
    .refine(defaultMatchesType, {
        message: "`default` does not match the field's `type`",
        path: ["default"],
    });
export type ManifestField = z.infer<typeof manifestFieldSchema>;

/** The on-chain call the template produces. Fixed in v1 (no user-driven binding). */
export const manifestBindingSchema = z.object({
    receiver_id: nearAccountString("binding.receiver_id"),
    method_name: methodNameString("binding.method_name"),
    deposit: integerString("binding.deposit"),
    gas: integerString("binding.gas"),
});
export type ManifestBinding = z.infer<typeof manifestBindingSchema>;

/**
 * One matcher for both extraction and substitution, kept as a single source so a charset tweak can't
 * leave one behind. It deliberately avoids a RegExp lookbehind: some runtimes (notably Safari < 16.4)
 * throw a SyntaxError on lookbehind at module-load, which would break every flow that imports this
 * module — not just template authoring. Instead the escaped `{{{{literal}}}}` block is matched first
 * and as a whole, so its inner `{{...}}` is consumed and never seen as a placeholder. Group 1 is the
 * escaped inner (rendered back as a literal `{{...}}`); group 2 is a real placeholder's field name.
 */
const PLACEHOLDER_SOURCE =
    "\\{\\{\\{\\{([\\s\\S]*?)\\}\\}\\}\\}|\\{\\{\\s*([a-zA-Z0-9_]+)\\s*\\}\\}";

/** Extraction: group 2 = name; an escaped block matches group 1 and carries no name (skipped). */
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_SOURCE, "g");

/** Substitution: group 1 = escaped inner, group 2 = placeholder name. */
const SUBSTITUTE_RE = new RegExp(PLACEHOLDER_SOURCE, "g");

function collectStrings(value: unknown, out: string[]): void {
    if (typeof value === "string") {
        out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out);
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) collectStrings(item, out);
    }
}

/**
 * Field names referenced via `{{name}}` anywhere in `value` — a manifest's `args` object or its
 * `summary` string. Exported so the form engine interpolates against the exact same extraction
 * this validator checks. Called per source so a dangling token is attributable to args vs summary.
 */
export function manifestPlaceholders(value: unknown): Set<string> {
    const strings: string[] = [];
    collectStrings(value, strings);
    const names = new Set<string>();
    for (const text of strings) {
        for (const match of text.matchAll(PLACEHOLDER_RE)) {
            const name = match[2];
            if (name) {
                names.add(name);
            }
        }
    }
    return names;
}

/**
 * Replace each `{{name}}` in `text` with `resolve(name)`. An escaped `{{{{...}}}}` collapses to a
 * literal `{{...}}` and is never treated as a placeholder — the same escape `manifestPlaceholders`
 * skips — so validation (extraction) and the form engine (substitution) never disagree on what a
 * placeholder is.
 */
export function substitutePlaceholders(
    text: string,
    resolve: (name: string) => string,
): string {
    return text.replace(
        SUBSTITUTE_RE,
        (_full, escaped: string | undefined, name: string | undefined) =>
            escaped === undefined ? resolve(name ?? "") : `{{${escaped}}}`,
    );
}

/** Whether every `{{placeholder}}` in `source` is declared as a field `name`. */
function placeholdersDeclared(
    fields: ReadonlyArray<{ name: string }>,
    source: unknown,
): boolean {
    const declared = new Set(fields.map((field) => field.name));
    return [...manifestPlaceholders(source)].every((name) =>
        declared.has(name),
    );
}

export const manifestSchema = z
    .object({
        // v1 is the only shape this validator describes; a future version needs its own schema.
        version: z.literal(1),
        id: tagSafeId,
        title: nonBlankString("title"),
        description: nonBlankString("description").optional(),
        icon: nonBlankString("icon").optional(),
        binding: manifestBindingSchema,
        fields: z.array(manifestFieldSchema),
        // `args` must be a plain object (z.record admits arrays in zod v4; z.object does not).
        args: z.object({}).catchall(z.unknown()),
        summary: nonBlankString("summary").optional(),
    })
    .refine(
        (manifest) => placeholdersDeclared(manifest.fields, manifest.args),
        {
            message: "references a {{placeholder}} that no field declares",
            path: ["args"],
        },
    )
    .refine(
        (manifest) => placeholdersDeclared(manifest.fields, manifest.summary),
        {
            message: "references a {{placeholder}} that no field declares",
            path: ["summary"],
        },
    )
    .refine(
        (manifest) => {
            const names = manifest.fields.map((field) => field.name);
            return new Set(names).size === names.length;
        },
        {
            message: "field `name`s must be unique within a manifest",
            path: ["fields"],
        },
    );
export type Manifest = z.infer<typeof manifestSchema>;

/** Validate an authored manifest (e.g. pasted JSON). Returns zod's safe-parse result. */
export function parseManifest(input: unknown) {
    return manifestSchema.safeParse(input);
}

/**
 * A manifest's `id` (its route slug + `[trezu-tmpl:<id>]` tag) read without full validation — for
 * listing templates and resolving `/custom-templates/<slug>` to a template. Mirrors the backend's
 * `manifest_id` generated column (`manifest->>'id'`). Returns undefined if the shape is off.
 */
export function manifestIdOf(manifest: unknown): string | undefined {
    if (manifest && typeof manifest === "object" && "id" in manifest) {
        const id = (manifest as { id: unknown }).id;
        return typeof id === "string" ? id : undefined;
    }
    return undefined;
}

/** Flatten a manifest validation error into `path: message` lines for the authoring UI. */
export function manifestErrorMessages(error: z.ZodError): string[] {
    return error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
    });
}

/**
 * Validate manifest JSON *text* (the authoring textarea): parse the JSON, then validate the shape.
 * Returns the validated manifest on success, or human-readable error lines (invalid JSON, or schema
 * issues). Empty/whitespace input yields no manifest and no errors — a pristine form, not an error.
 */
export function validateManifestText(text: string): {
    manifest?: Manifest;
    errors: string[];
} {
    if (!text.trim()) {
        return { errors: [] };
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { errors: ["Manifest is not valid JSON"] };
    }
    const result = parseManifest(json);
    if (!result.success) {
        return { errors: manifestErrorMessages(result.error) };
    }
    return { manifest: result.data, errors: [] };
}

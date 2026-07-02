import { describe, expect, it } from "bun:test";
import {
    manifestErrorMessages,
    manifestPlaceholders,
    parseManifest,
    validateManifestText,
} from "./manifest";

const validManifest = {
    version: 1,
    id: "guestbook-tip",
    title: "Guestbook Tip",
    binding: {
        receiver_id: "guestbook.near",
        method_name: "add_message",
        deposit: "1",
        gas: "30000000000000",
    },
    fields: [{ name: "amount", label: "Amount", type: "uint", required: true }],
    args: { amount: "{{amount}}" },
    summary: "Tip {{amount}}",
};

describe("parseManifest", () => {
    it("accepts a valid manifest and trims its string fields", () => {
        const result = parseManifest({
            ...validManifest,
            id: "  guestbook-tip  ",
            title: "  Guestbook Tip  ",
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.id).toBe("guestbook-tip");
            expect(result.data.title).toBe("Guestbook Tip");
        }
    });

    it("rejects a non-object", () => {
        expect(parseManifest("not an object").success).toBe(false);
    });

    it("rejects a blank id", () => {
        expect(parseManifest({ ...validManifest, id: "   " }).success).toBe(
            false,
        );
    });

    it("rejects a missing binding field", () => {
        const result = parseManifest({
            ...validManifest,
            binding: { method_name: "add_message", deposit: "1", gas: "1" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects a non-integer deposit (u128 must be an integer string)", () => {
        const result = parseManifest({
            ...validManifest,
            binding: { ...validManifest.binding, deposit: "1.5" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects an unknown field type", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [{ name: "x", label: "X", type: "bogus" }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects a non-integer validation.min on a field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "uint",
                    validation: { min: "1.5" },
                },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects args that is not an object", () => {
        expect(
            parseManifest({ ...validManifest, args: ["not", "a", "record"] })
                .success,
        ).toBe(false);
    });

    it("attributes a dangling args placeholder to `args`, not `summary`", () => {
        const result = parseManifest({
            ...validManifest,
            args: { amount: "{{missing}}" },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            expect(messages.some((m) => m.startsWith("args:"))).toBe(true);
        }
    });

    it("attributes a dangling summary placeholder to `summary`, not `args`", () => {
        const result = parseManifest({
            ...validManifest,
            summary: "Tip {{amount}} to {{missing}}",
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            expect(messages.some((m) => m.startsWith("summary:"))).toBe(true);
        }
    });

    it("rejects a default that does not match the field type", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "uint",
                    default: "banana",
                },
            ],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            expect(
                messages.some((m) => m.startsWith("fields.0.default:")),
            ).toBe(true);
        }
    });

    it("rejects an empty-string default on a text field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                { name: "amount", label: "Amount", type: "text", default: "" },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects a select field without options", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [{ name: "amount", label: "Amount", type: "select" }],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            expect(
                messages.some((m) => m.startsWith("fields.0.options:")),
            ).toBe(true);
        }
    });

    it("rejects (without crashing) a select field that has a default but no options", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "select",
                    default: "x",
                },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects options on a non-select field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "text",
                    options: ["a"],
                },
            ],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            expect(
                messages.some((m) => m.startsWith("fields.0.options:")),
            ).toBe(true);
        }
    });

    it("rejects an id that is not a tag-safe slug", () => {
        expect(parseManifest({ ...validManifest, id: "bad id]" }).success).toBe(
            false,
        );
    });

    it("rejects a reserved route slug as the id", () => {
        expect(parseManifest({ ...validManifest, id: "create" }).success).toBe(
            false,
        );
    });

    it("rejects a field name that is not a {{placeholder}}-safe identifier", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [{ name: "user-id", label: "User", type: "text" }],
            args: {},
            summary: "Static summary",
        });
        expect(result.success).toBe(false);
    });

    it("rejects duplicate field names", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                { name: "amount", label: "Amount", type: "uint" },
                { name: "amount", label: "Amount 2", type: "text" },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects an unsupported manifest version", () => {
        expect(parseManifest({ ...validManifest, version: 2 }).success).toBe(
            false,
        );
    });

    it("accepts a validation.pattern on a text field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "text",
                    validation: { pattern: "^a" },
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it("rejects a validation.pattern on a non-text/number field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "uint",
                    validation: { pattern: "^a" },
                },
            ],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            // The refine is on the field schema, so the path is rooted at the field index.
            expect(
                messages.some((m) =>
                    m.startsWith("fields.0.validation.pattern:"),
                ),
            ).toBe(true);
        }
    });

    it("rejects a validation.pattern that is not a valid regex", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "text",
                    validation: { pattern: "[abc" },
                },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects validation.min/max on a non-numeric field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "text",
                    validation: { min: "5" },
                },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("rejects required: true on a bool field", () => {
        const result = parseManifest({
            ...validManifest,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "bool",
                    required: true,
                },
            ],
        });
        expect(result.success).toBe(false);
    });

    it("accepts a type-appropriate default for each field type", () => {
        const fields = [
            { name: "amount", label: "Amount", type: "bool", default: true },
            { name: "amount", label: "Amount", type: "number", default: 5 },
            {
                name: "amount",
                label: "Amount",
                type: "json",
                default: { a: 1 },
            },
            {
                name: "amount",
                label: "Amount",
                type: "select",
                options: ["a", "b"],
                default: "a",
            },
        ];
        for (const field of fields) {
            const result = parseManifest({ ...validManifest, fields: [field] });
            expect(result.success).toBe(true);
        }
    });
});

describe("manifestErrorMessages", () => {
    it("returns `path: message` lines for each issue", () => {
        const result = parseManifest({ ...validManifest, id: "" });
        expect(result.success).toBe(false);
        if (!result.success) {
            const messages = manifestErrorMessages(result.error);
            expect(messages.length).toBeGreaterThan(0);
            expect(messages.some((m) => m.startsWith("id:"))).toBe(true);
        }
    });
});

describe("manifestPlaceholders", () => {
    it("extracts {{name}} from object values, arrays, and nested structures", () => {
        const found = manifestPlaceholders({
            a: "{{x}}",
            b: "static text",
            c: ["{{y}}", { d: "{{z}}" }],
        });
        expect([...found].sort()).toEqual(["x", "y", "z"]);
    });

    it("ignores escaped {{{{literal}}}} sequences", () => {
        expect(manifestPlaceholders("a {{{{literal}}}} b").size).toBe(0);
    });

    it("tolerates undefined / non-string / null values", () => {
        expect(manifestPlaceholders(undefined).size).toBe(0);
        expect(manifestPlaceholders({ n: 5, b: true, z: null }).size).toBe(0);
        expect([...manifestPlaceholders(["{{x}}"])]).toEqual(["x"]);
    });
});

describe("validateManifestText", () => {
    it("treats empty / whitespace-only input as pristine (no manifest, no errors)", () => {
        expect(validateManifestText("")).toEqual({ errors: [] });
        expect(validateManifestText("   \n  ")).toEqual({ errors: [] });
    });

    it("reports invalid JSON without throwing", () => {
        const result = validateManifestText("{ not json");
        expect(result.manifest).toBeUndefined();
        expect(result.errors).toEqual(["Manifest is not valid JSON"]);
    });

    it("surfaces schema errors as `path: message` lines for valid JSON", () => {
        const result = validateManifestText(
            JSON.stringify({ ...validManifest, id: "" }),
        );
        expect(result.manifest).toBeUndefined();
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((m) => m.startsWith("id:"))).toBe(true);
    });

    it("returns the parsed (and trimmed) manifest on success", () => {
        const result = validateManifestText(
            JSON.stringify({ ...validManifest, id: "  demo-tip  " }),
        );
        expect(result.errors).toEqual([]);
        expect(result.manifest?.id).toBe("demo-tip");
    });
});

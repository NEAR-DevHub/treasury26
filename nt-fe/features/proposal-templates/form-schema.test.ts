import { describe, expect, it } from "bun:test";
import {
    buildFormSchema,
    defaultValuesFor,
    type ValidationMessages,
} from "./form-schema";
import {
    type Manifest,
    manifestErrorMessages,
    parseManifest,
} from "./manifest";

// These tests assert validation behaviour, not message text — a plain English stub is enough.
const messages: ValidationMessages = {
    required: (l) => `${l} is required`,
    account: (l) => `${l} must be a valid NEAR account`,
    wholeNumber: (l) => `${l} must be a whole number`,
    number: (l) => `${l} must be a number`,
    select: (l) => `${l}: choose a listed option`,
    json: (l) => `${l} must be valid JSON`,
    invalid: (l) => `${l} is invalid`,
    pattern: (l) => `${l} does not match the required pattern`,
    min: (l, min) => `${l} must be at least ${min}`,
    max: (l, max) => `${l} must be at most ${max}`,
};

function manifest(raw: unknown): Manifest {
    const result = parseManifest(raw);
    if (!result.success) {
        throw new Error(manifestErrorMessages(result.error).join("; "));
    }
    return result.data;
}

/** A minimal valid manifest carrying the given fields (args stays `{}` so the cross-check passes). */
function withFields(fields: unknown[]): Manifest {
    return manifest({
        version: 1,
        id: "t",
        title: "T",
        binding: {
            receiver_id: "x.near",
            method_name: "m",
            deposit: "1",
            gas: "1",
        },
        fields,
        args: {},
    });
}

function schemaFor(field: unknown) {
    return buildFormSchema(withFields([field]), messages);
}

describe("buildFormSchema", () => {
    it("requires a required field but accepts a valid value", () => {
        const schema = schemaFor({
            name: "amount",
            label: "Amount",
            type: "uint",
            required: true,
        });
        expect(schema.safeParse({ amount: "" }).success).toBe(false);
        expect(schema.safeParse({ amount: "100" }).success).toBe(true);
    });

    it("requires a required account field", () => {
        const schema = schemaFor({
            name: "acct",
            label: "Account",
            type: "account",
            required: true,
        });
        expect(schema.safeParse({ acct: "" }).success).toBe(false);
        expect(schema.safeParse({ acct: "alice.near" }).success).toBe(true);
    });

    it("requires a required select field", () => {
        const schema = schemaFor({
            name: "net",
            label: "Net",
            type: "select",
            options: ["eth", "base"],
            required: true,
        });
        expect(schema.safeParse({ net: "" }).success).toBe(false);
        expect(schema.safeParse({ net: "eth" }).success).toBe(true);
    });

    it("lets an optional field be empty", () => {
        const schema = schemaFor({ name: "memo", label: "Memo", type: "text" });
        expect(schema.safeParse({ memo: "" }).success).toBe(true);
    });

    it("rejects a non-integer for a uint field", () => {
        const schema = schemaFor({
            name: "amount",
            label: "Amount",
            type: "uint",
        });
        expect(schema.safeParse({ amount: "1.5" }).success).toBe(false);
        expect(schema.safeParse({ amount: "101021" }).success).toBe(true);
    });

    it("validates a NEAR account field", () => {
        const schema = schemaFor({
            name: "acct",
            label: "Account",
            type: "account",
        });
        expect(schema.safeParse({ acct: "alice.near" }).success).toBe(true);
        expect(schema.safeParse({ acct: "Bad Account" }).success).toBe(false);
    });

    it("restricts a select field to its options", () => {
        const schema = schemaFor({
            name: "net",
            label: "Net",
            type: "select",
            options: ["eth", "base"],
        });
        expect(schema.safeParse({ net: "base" }).success).toBe(true);
        expect(schema.safeParse({ net: "sol" }).success).toBe(false);
    });

    it("requires a bool field to be a boolean", () => {
        const schema = schemaFor({ name: "flag", label: "Flag", type: "bool" });
        expect(schema.safeParse({ flag: true }).success).toBe(true);
        expect(schema.safeParse({ flag: "yes" }).success).toBe(false);
    });

    it("rejects invalid JSON for a json field", () => {
        const schema = schemaFor({ name: "cfg", label: "Cfg", type: "json" });
        expect(schema.safeParse({ cfg: '{"a":1}' }).success).toBe(true);
        expect(schema.safeParse({ cfg: "{not json" }).success).toBe(false);
    });

    it("enforces a validation.pattern on a text field", () => {
        const schema = schemaFor({
            name: "code",
            label: "Code",
            type: "text",
            validation: { pattern: "^[A-Z]{3}$" },
        });
        expect(schema.safeParse({ code: "ABC" }).success).toBe(true);
        expect(schema.safeParse({ code: "abc" }).success).toBe(false);
    });

    it("enforces validation.min/max with Big (precise past 2^53)", () => {
        const schema = schemaFor({
            name: "amount",
            label: "Amount",
            type: "uint",
            validation: { min: "10", max: "100" },
        });
        expect(schema.safeParse({ amount: "50" }).success).toBe(true);
        expect(schema.safeParse({ amount: "5" }).success).toBe(false);
        expect(schema.safeParse({ amount: "101" }).success).toBe(false);

        const huge = schemaFor({
            name: "amount",
            label: "Amount",
            type: "uint",
            validation: { min: "9007199254740993" }, // 2^53 + 1
        });
        expect(huge.safeParse({ amount: "9007199254740994" }).success).toBe(
            true,
        );
        expect(huge.safeParse({ amount: "9007199254740992" }).success).toBe(
            false,
        );
    });
});

describe("defaultValuesFor", () => {
    it("coerces each field's default to its form representation, else a typed empty", () => {
        const m = withFields([
            { name: "a", label: "A", type: "text" },
            { name: "b", label: "B", type: "bool" },
            { name: "c", label: "C", type: "number", default: 5 },
            { name: "d", label: "D", type: "bool", default: true },
            { name: "e", label: "E", type: "json", default: { k: 1 } },
            { name: "f", label: "F", type: "uint", default: "100" },
        ]);
        expect(defaultValuesFor(m)).toEqual({
            a: "",
            b: false,
            c: "5",
            d: true,
            e: '{"k":1}',
            f: "100",
        });
    });

    it("coerces non-bool fields without a default to an empty string", () => {
        const m = withFields([
            { name: "a", label: "A", type: "text" },
            { name: "b", label: "B", type: "account" },
            { name: "c", label: "C", type: "select", options: ["x", "y"] },
        ]);
        expect(defaultValuesFor(m)).toEqual({ a: "", b: "", c: "" });
    });
});

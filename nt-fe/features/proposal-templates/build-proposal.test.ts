import { describe, expect, it } from "bun:test";
import { base64ToJson } from "@/lib/utils";
import { buildTemplateProposal, interpolateArgs } from "./build-proposal";
import {
    type Manifest,
    type ManifestFieldType,
    manifestErrorMessages,
    parseManifest,
} from "./manifest";

/** Parse a fixture through the real validator so the engine is only ever fed valid manifests. */
function manifest(raw: unknown): Manifest {
    const result = parseManifest(raw);
    if (!result.success) {
        throw new Error(manifestErrorMessages(result.error).join("; "));
    }
    return result.data;
}

// A guestbook post with a tip — a FunctionCall exercising static, direct, and composed args.
const rawGuestbook = {
    version: 1,
    id: "guestbook-tip",
    title: "Guestbook Tip",
    binding: {
        receiver_id: "guestbook.near",
        method_name: "add_message",
        deposit: "1",
        gas: "30000000000000",
    },
    fields: [
        { name: "message", label: "Message", type: "text" },
        { name: "author", label: "Author", type: "account" },
        { name: "tip", label: "Tip (yocto)", type: "uint" },
    ],
    args: {
        app: "trezu", // static
        text: "{{message}}", // direct
        amount: "{{tip}}", // direct, u128
        meta: '{"by":"{{author}}"}', // composed: a field inside a JSON string
    },
    summary: "Tip {{tip}} from {{author}}",
};

const guestbookValues = {
    message: "gm",
    author: "alice.near",
    tip: "5",
};

// A call whose args mix every typed-injection case: a lone bool/number/json reaches the contract
// typed, while a u128 `uint` and any composed value stay strings.
const rawTyped = {
    version: 1,
    id: "typed-args",
    title: "Typed Args",
    binding: {
        receiver_id: "config.near",
        method_name: "configure",
        deposit: "0",
        gas: "30000000000000",
    },
    fields: [
        { name: "enabled", label: "Enabled", type: "bool" },
        { name: "count", label: "Count", type: "number" },
        { name: "config", label: "Config", type: "json" },
        { name: "amount", label: "Amount", type: "uint" },
        { name: "note", label: "Note", type: "text" },
    ],
    args: {
        enabled: "{{enabled}}", // lone bool -> boolean
        count: "{{count}}", // lone number -> number
        config: "{{config}}", // lone json -> parsed value
        amount: "{{amount}}", // lone uint -> string (u128 safety)
        note: "{{note}}", // lone text -> string
        label: "n={{count}}", // composed -> string
    },
};

const typedValues = {
    enabled: true,
    count: "5",
    config: '{"k":1}',
    amount: "1000",
    note: "hi",
};

describe("interpolateArgs", () => {
    it("substitutes placeholders in nested strings, arrays, and objects", () => {
        const out = interpolateArgs(
            { a: "{{x}}", b: ["{{y}}", { c: "z={{x}}" }], n: 5 },
            { x: "X", y: "Y" },
        );
        expect(out).toEqual({ a: "X", b: ["Y", { c: "z=X" }], n: 5 });
    });

    it("resolves a missing value to an empty string", () => {
        expect(interpolateArgs("{{absent}}", {})).toBe("");
    });

    it("stringifies number, boolean, and json values", () => {
        expect(
            interpolateArgs("{{n}}/{{b}}/{{j}}", {
                n: 7,
                b: true,
                j: { k: 1 },
            }),
        ).toBe('7/true/{"k":1}');
    });

    it("collapses an escaped {{{{literal}}}} to {{literal}}", () => {
        expect(interpolateArgs("{{{{keep}}}} {{x}}", { x: "X" })).toBe(
            "{{keep}} X",
        );
    });

    it("does not type-resolve an escaped {{{{name}}}} (stays a string)", () => {
        const types = new Map<string, ManifestFieldType>([["b", "bool"]]);
        expect(interpolateArgs("{{{{b}}}}", { b: true }, types)).toBe("{{b}}");
    });

    it("returns an empty args object unchanged", () => {
        expect(interpolateArgs({}, {})).toEqual({});
    });

    it("tolerates whitespace inside a placeholder ({{ name }})", () => {
        expect(interpolateArgs("{{ x }}", { x: "X" })).toBe("X");
    });
});

describe("buildTemplateProposal", () => {
    it("reproduces the add_message call exactly", () => {
        const { kind } = buildTemplateProposal(
            manifest(rawGuestbook),
            guestbookValues,
        );
        const fc = kind.FunctionCall;

        expect(fc.receiver_id).toBe("guestbook.near");
        expect(fc.actions).toHaveLength(1);

        const action = fc.actions[0];
        expect(action.method_name).toBe("add_message");
        expect(action.deposit).toBe("1");
        expect(action.gas).toBe("30000000000000");
        expect(base64ToJson(action.args)).toEqual({
            app: "trezu",
            text: "gm",
            amount: "5",
            meta: '{"by":"alice.near"}',
        });
    });

    it("keeps a u128 amount as a digit string (never a JS number)", () => {
        const big = "340282366920938463463374607431768211455"; // 2^128 - 1
        const { kind } = buildTemplateProposal(manifest(rawGuestbook), {
            ...guestbookValues,
            tip: big,
        });
        expect(base64ToJson(kind.FunctionCall.actions[0].args).amount).toBe(
            big,
        );
    });

    it("tags the description with [trezu-tmpl:<id>] and interpolates the summary", () => {
        const { description } = buildTemplateProposal(
            manifest(rawGuestbook),
            guestbookValues,
        );
        expect(description).toContain("[trezu-tmpl:guestbook-tip]");
        expect(description).toContain("Tip 5");
    });

    it("falls back to the title when no summary is declared", () => {
        const { description } = buildTemplateProposal(
            manifest({ ...rawGuestbook, summary: undefined }),
            guestbookValues,
        );
        expect(description).toContain("Guestbook Tip");
    });

    it("emits a lone bool/number/json typed, but keeps uint and composed strings", () => {
        const { kind } = buildTemplateProposal(manifest(rawTyped), typedValues);
        expect(base64ToJson(kind.FunctionCall.actions[0].args)).toEqual({
            enabled: true, // boolean, not "true"
            count: 5, // number, not "5"
            config: { k: 1 }, // parsed JSON, not the string
            amount: "1000", // u128 stays a digit string
            note: "hi",
            label: "n=5", // composed stays a string
        });
    });
});

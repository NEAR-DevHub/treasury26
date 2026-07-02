import { describe, expect, it } from "bun:test";
import {
    changeType,
    duplicateArgKeys,
    dynamicArgNames,
    emptyNodeOf,
    isDynamicArg,
    resolveDisplayType,
    valueTypeOf,
} from "./args-node";
import type { ArgEntry } from "./draft";

describe("valueTypeOf", () => {
    it("infers `field` for a lone placeholder, `text` otherwise", () => {
        expect(valueTypeOf({ kind: "string", value: "{{amount}}" })).toBe(
            "field",
        );
        expect(valueTypeOf({ kind: "string", value: "hi {{amount}}" })).toBe(
            "text",
        );
        expect(valueTypeOf({ kind: "string", value: "static" })).toBe("text");
    });

    it("maps non-string kinds directly", () => {
        expect(valueTypeOf({ kind: "object", entries: [] })).toBe("object");
        expect(valueTypeOf({ kind: "array", items: [] })).toBe("array");
        expect(valueTypeOf({ kind: "number", value: 1 })).toBe("number");
        expect(valueTypeOf({ kind: "boolean", value: true })).toBe("boolean");
        expect(valueTypeOf({ kind: "null" })).toBe("null");
    });
});

describe("emptyNodeOf", () => {
    it("seeds a `field` node with the first declared field", () => {
        expect(emptyNodeOf("field", ["amount", "token"])).toEqual({
            kind: "string",
            value: "{{amount}}",
        });
    });

    it("seeds an empty string for `field` when nothing is declared", () => {
        expect(emptyNodeOf("field", [])).toEqual({ kind: "string", value: "" });
    });

    it("builds empty containers and scalars", () => {
        expect(emptyNodeOf("object", [])).toEqual({
            kind: "object",
            entries: [],
        });
        expect(emptyNodeOf("array", [])).toEqual({ kind: "array", items: [] });
        expect(emptyNodeOf("number", [])).toEqual({ kind: "number", value: 0 });
        expect(emptyNodeOf("null", [])).toEqual({ kind: "null" });
    });
});

describe("changeType", () => {
    it("keeps the string as-is when switching to `text`", () => {
        const node = { kind: "string", value: "hi {{x}}" } as const;
        expect(changeType(node, "text", [])).toBe(node);
    });

    it("keeps a lone placeholder when switching `text` → `field`", () => {
        const node = { kind: "string", value: "{{amount}}" } as const;
        expect(changeType(node, "field", ["amount"])).toBe(node);
    });

    it("seeds a field when switching free text → `field`", () => {
        expect(
            changeType({ kind: "string", value: "hello" }, "field", ["amount"]),
        ).toEqual({ kind: "string", value: "{{amount}}" });
    });

    it("resets to an empty node when changing across kinds", () => {
        expect(changeType({ kind: "number", value: 5 }, "boolean", [])).toEqual(
            { kind: "boolean", value: false },
        );
    });

    it("leaves a lone placeholder unchanged on field → text (display override handles it)", () => {
        const node = { kind: "string", value: "{{amount}}" } as const;
        expect(changeType(node, "text", [])).toBe(node);
    });

    it("resets a string to an empty container when switching to object or array", () => {
        const node = { kind: "string", value: "{{amount}}" } as const;
        expect(changeType(node, "object", [])).toEqual({
            kind: "object",
            entries: [],
        });
        expect(changeType(node, "array", [])).toEqual({
            kind: "array",
            items: [],
        });
    });
});

describe("resolveDisplayType", () => {
    it("returns the inferred type when there's no explicit pick", () => {
        expect(
            resolveDisplayType({ kind: "string", value: "{{x}}" }, null),
        ).toBe("field");
    });

    it("honors an explicit text pick on a lone placeholder (no snap-back)", () => {
        expect(
            resolveDisplayType({ kind: "string", value: "{{x}}" }, "text"),
        ).toBe("text");
    });

    it("honors an explicit field pick on free text", () => {
        expect(
            resolveDisplayType({ kind: "string", value: "hi" }, "field"),
        ).toBe("field");
    });

    it("ignores an explicit pick that no longer matches the node's kind", () => {
        expect(resolveDisplayType({ kind: "number", value: 1 }, "text")).toBe(
            "number",
        );
    });
});

describe("isDynamicArg / dynamicArgNames", () => {
    it("flags an entry whose value is exactly {{key}}", () => {
        expect(
            isDynamicArg({
                id: "1",
                key: "amount",
                value: { kind: "string", value: "{{amount}}" },
            }),
        ).toBe(true);
    });

    it("rejects a mismatched placeholder, composed text, blank key, or non-string", () => {
        expect(
            isDynamicArg({
                id: "1",
                key: "amount",
                value: { kind: "string", value: "{{other}}" },
            }),
        ).toBe(false);
        expect(
            isDynamicArg({
                id: "1",
                key: "amount",
                value: { kind: "string", value: "x {{amount}}" },
            }),
        ).toBe(false);
        expect(
            isDynamicArg({
                id: "1",
                key: "",
                value: { kind: "string", value: "{{}}" },
            }),
        ).toBe(false);
        expect(
            isDynamicArg({
                id: "1",
                key: "amount",
                value: { kind: "number", value: 1 },
            }),
        ).toBe(false);
    });

    it("collects the keys of dynamic arguments only", () => {
        const entries: ArgEntry[] = [
            {
                id: "1",
                key: "amount",
                value: { kind: "string", value: "{{amount}}" },
            },
            {
                id: "2",
                key: "owner",
                value: { kind: "string", value: "vault.near" },
            },
        ];
        expect([...dynamicArgNames(entries)]).toEqual(["amount"]);
    });
});

describe("duplicateArgKeys", () => {
    it("flags a top-level repeat with an empty path", () => {
        const entries: ArgEntry[] = [
            { id: "1", key: "a", value: { kind: "string", value: "x" } },
            { id: "2", key: "b", value: { kind: "string", value: "y" } },
            { id: "3", key: "a", value: { kind: "string", value: "z" } },
        ];
        expect(duplicateArgKeys(entries)).toEqual([{ path: "", key: "a" }]);
    });

    it("reports a key repeated 3+ times only once", () => {
        const entries: ArgEntry[] = [
            { id: "1", key: "a", value: { kind: "string", value: "1" } },
            { id: "2", key: "a", value: { kind: "string", value: "2" } },
            { id: "3", key: "a", value: { kind: "string", value: "3" } },
        ];
        expect(duplicateArgKeys(entries)).toEqual([{ path: "", key: "a" }]);
    });

    it("ignores blank keys (mid-edit) and all-unique keys", () => {
        const entries: ArgEntry[] = [
            { id: "1", key: "", value: { kind: "string", value: "" } },
            { id: "2", key: "", value: { kind: "string", value: "" } },
            { id: "3", key: "a", value: { kind: "string", value: "z" } },
        ];
        expect(duplicateArgKeys(entries)).toEqual([]);
    });

    it("tags a duplicate nested in an object with its path", () => {
        const entries: ArgEntry[] = [
            {
                id: "1",
                key: "outer",
                value: {
                    kind: "object",
                    entries: [
                        {
                            id: "2",
                            key: "dup",
                            value: { kind: "string", value: "1" },
                        },
                        {
                            id: "3",
                            key: "dup",
                            value: { kind: "string", value: "2" },
                        },
                    ],
                },
            },
        ];
        expect(duplicateArgKeys(entries)).toEqual([
            { path: "outer", key: "dup" },
        ]);
    });

    it("includes the array index in the path of a duplicate inside an array item", () => {
        const entries: ArgEntry[] = [
            {
                id: "1",
                key: "list",
                value: {
                    kind: "array",
                    items: [
                        {
                            id: "i0",
                            value: {
                                kind: "object",
                                entries: [
                                    {
                                        id: "2",
                                        key: "k",
                                        value: { kind: "string", value: "1" },
                                    },
                                    {
                                        id: "3",
                                        key: "k",
                                        value: { kind: "string", value: "2" },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        ];
        expect(duplicateArgKeys(entries)).toEqual([
            { path: "list.0", key: "k" },
        ]);
    });
});

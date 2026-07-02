import { describe, expect, it } from "bun:test";
import {
    type ArgEntry,
    argNodeToJson,
    draftToManifest,
    emptyDraft,
    jsonToArgNode,
    jsonToDraft,
    makeFieldDraft,
    manifestToDraft,
    normalizeFields,
} from "./draft";
import { type Manifest, parseManifest } from "./manifest";

const guestbook = {
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
        { name: "tip", label: "Tip", type: "uint", required: true },
        { name: "author", label: "Author", type: "account", required: true },
    ],
    args: {
        app: "trezu",
        text: "{{message}}",
        amount: "{{tip}}",
        meta: '{"by":"{{author}}"}',
    },
    summary: "Tip {{tip}}",
};

/** Parse a fixture, push it through the draft, re-parse — both ends are normalized manifests. */
function roundTrip(input: unknown): { original: Manifest; reparsed: Manifest } {
    const original = parseManifest(input);
    if (!original.success) {
        throw new Error("fixture must be a valid manifest");
    }
    const draft = manifestToDraft(original.data);
    const reparsed = parseManifest(draftToManifest(draft));
    if (!reparsed.success) {
        throw new Error(
            `round-trip produced an invalid manifest: ${JSON.stringify(reparsed.error.issues)}`,
        );
    }
    return { original: original.data, reparsed: reparsed.data };
}

describe("jsonToArgNode / argNodeToJson", () => {
    it("round-trips primitives, arrays, nested objects, and placeholder strings", () => {
        const values: unknown[] = [
            null,
            "static",
            "{{field}}",
            '{"receiver_id":"{{receiver}}"}',
            42,
            true,
            ["a", 1, false, null],
            { a: "x", b: { c: ["{{y}}"] }, d: [] },
            {},
        ];
        for (const value of values) {
            expect(argNodeToJson(jsonToArgNode(value))).toEqual(value);
        }
    });

    it("preserves object key order", () => {
        const node = jsonToArgNode({ z: 1, a: 2, m: 3 });
        expect(
            node.kind === "object" && node.entries.map((e) => e.key),
        ).toEqual(["z", "a", "m"]);
    });
});

describe("manifestToDraft / draftToManifest", () => {
    it("round-trips the guestbook template through the draft losslessly", () => {
        const { original, reparsed } = roundTrip(guestbook);
        expect(reparsed).toEqual(original);
    });

    it("round-trips field options, validation, and typed defaults of every type", () => {
        const { original, reparsed } = roundTrip({
            ...guestbook,
            fields: [
                {
                    name: "amount",
                    label: "Amount",
                    type: "amount",
                    required: true,
                    validation: { min: "1", max: "100" },
                },
                {
                    name: "memo",
                    label: "Memo",
                    type: "text",
                    default: "hi",
                    validation: { pattern: "^h" },
                },
                { name: "count", label: "Count", type: "number", default: 5 },
                { name: "agree", label: "Agree", type: "bool", default: true },
                {
                    name: "chain",
                    label: "Chain",
                    type: "select",
                    options: ["eth", "base"],
                    default: "eth",
                },
            ],
            args: {
                amount: "{{amount}}",
                memo: "{{memo}}",
                count: "{{count}}",
                agree: "{{agree}}",
                chain: "{{chain}}",
            },
            summary: "static",
        });
        expect(reparsed).toEqual(original);
    });

    it("preserves optional meta (description, icon, summary)", () => {
        const { reparsed } = roundTrip({
            ...guestbook,
            description: "A demo",
            icon: "coin",
        });
        expect(reparsed.description).toBe("A demo");
        expect(reparsed.icon).toBe("coin");
        expect(reparsed.summary).toBe("Tip {{tip}}");
    });

    it("omits blank optional meta from the serialized manifest", () => {
        const draft = emptyDraft();
        draft.id = "x";
        draft.title = "X";
        const manifest = draftToManifest(draft);
        expect("description" in manifest).toBe(false);
        expect("icon" in manifest).toBe(false);
        expect("summary" in manifest).toBe(false);
    });
});

describe("jsonToDraft (lenient, for Code → Visual mid-edit)", () => {
    it("tolerates a partial manifest, filling blanks and gas/deposit defaults", () => {
        const draft = jsonToDraft({ id: "x", fields: [{ name: "a" }] });
        expect(draft.id).toBe("x");
        expect(draft.title).toBe("");
        expect(draft.binding.receiver_id).toBe("");
        expect(draft.binding.deposit).toBe("0");
        expect(draft.binding.gas).toBe("30000000000000");
        expect(draft.fields).toHaveLength(1);
        expect(draft.fields[0].name).toBe("a");
        // An unknown/missing field type degrades to "text" rather than throwing.
        expect(draft.fields[0].type).toBe("text");
        expect(draft.args).toEqual([]);
    });

    it("falls back gracefully for non-object input", () => {
        expect(jsonToDraft(null).fields).toEqual([]);
        expect(jsonToDraft("nope").id).toBe("");
    });
});

describe("normalizeFields (args-first auto-derive)", () => {
    function argsFrom(obj: Record<string, unknown>): ArgEntry[] {
        const node = jsonToArgNode(obj);
        return node.kind === "object" ? node.entries : [];
    }

    it("creates a field per new placeholder in args, with a Title-Cased label", () => {
        const draft = normalizeFields({
            ...emptyDraft(),
            args: argsFrom({ amount: "{{amount}}", to: "{{tx_hash}}" }),
        });
        const byName = Object.fromEntries(
            draft.fields.map((field) => [field.name, field]),
        );
        expect(Object.keys(byName).sort()).toEqual(["amount", "tx_hash"]);
        expect(byName.tx_hash.label).toBe("Tx Hash");
        expect(byName.amount.type).toBe("text");
    });

    it("picks up placeholders from the summary and composed strings", () => {
        const draft = normalizeFields({
            ...emptyDraft(),
            summary: "Tip {{amount}}",
            args: argsFrom({ msg: '{"to":"{{rcv}}"}' }),
        });
        expect(draft.fields.map((field) => field.name).sort()).toEqual([
            "amount",
            "rcv",
        ]);
    });

    it("leaves an existing field and its config untouched", () => {
        const existing = {
            ...makeFieldDraft(),
            name: "amount",
            label: "Custom",
            required: true,
        };
        const draft = normalizeFields({
            ...emptyDraft(),
            fields: [existing],
            args: argsFrom({ amount: "{{amount}}" }),
        });
        expect(draft.fields).toHaveLength(1);
        expect(draft.fields[0].label).toBe("Custom");
        expect(draft.fields[0].required).toBe(true);
    });

    it("keeps unreferenced fields and returns the same reference when nothing changed", () => {
        const normalized = normalizeFields({
            ...emptyDraft(),
            fields: [{ ...makeFieldDraft(), name: "unused", label: "Unused" }],
            args: argsFrom({ amount: "{{amount}}" }),
        });
        expect(normalized.fields.map((field) => field.name).sort()).toEqual([
            "amount",
            "unused",
        ]);
        // Re-running with nothing new to add returns the same object (no needless re-render).
        expect(normalizeFields(normalized)).toBe(normalized);
    });
});

/**
 * The args-tree editor's value-type layer over `ArgNode`. The model stores string leaves as plain
 * strings (which may embed `{{field}}` placeholders); the editor presents a friendlier type choice
 * where a string is either a single-field reference ("field") or free "text". These pure helpers
 * map between the two and seed new nodes — kept out of the component so they're unit-testable.
 */
import type { ArgEntry, ArgNode } from "./draft";

export type ArgValueType =
    | "text"
    | "field"
    | "number"
    | "boolean"
    | "null"
    | "object"
    | "array";

export const ARG_VALUE_TYPES: ArgValueType[] = [
    "text",
    "field",
    "number",
    "boolean",
    "null",
    "object",
    "array",
];

/** A string that is exactly one `{{field}}` placeholder (group 1 = the field name). */
export const SINGLE_FIELD_RE = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

/** The editor value-type for a node — a string is "field" iff it's a lone placeholder. */
export function valueTypeOf(node: ArgNode): ArgValueType {
    switch (node.kind) {
        case "object":
            return "object";
        case "array":
            return "array";
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "string":
            return SINGLE_FIELD_RE.test(node.value) ? "field" : "text";
    }
}

/** A fresh node for a chosen type; a "field" node seeds the first declared field, if any. */
export function emptyNodeOf(type: ArgValueType, fieldNames: string[]): ArgNode {
    switch (type) {
        case "object":
            return { kind: "object", entries: [] };
        case "array":
            return { kind: "array", items: [] };
        case "number":
            return { kind: "number", value: 0 };
        case "boolean":
            return { kind: "boolean", value: false };
        case "null":
            return { kind: "null" };
        case "field":
            return {
                kind: "string",
                value: fieldNames[0] ? `{{${fieldNames[0]}}}` : "",
            };
        case "text":
            return { kind: "string", value: "" };
    }
}

/** Change a node's type, preserving the string content when staying within string kinds. */
export function changeType(
    node: ArgNode,
    type: ArgValueType,
    fieldNames: string[],
): ArgNode {
    if (node.kind === "string") {
        if (type === "text") {
            return node;
        }
        if (type === "field") {
            return SINGLE_FIELD_RE.test(node.value)
                ? node
                : emptyNodeOf("field", fieldNames);
        }
    }
    return emptyNodeOf(type, fieldNames);
}

/**
 * The value-type the dropdown should show: the user's explicit pick when it's still compatible with
 * the node, else the inferred type. A lone-placeholder string infers as "field", so picking "text"
 * on it would otherwise snap back — both "text" and "field" are valid displays of a string's value,
 * so an explicit string choice is honored until the type genuinely changes.
 */
export function resolveDisplayType(
    node: ArgNode,
    explicit: ArgValueType | null,
): ArgValueType {
    const inferred = valueTypeOf(node);
    if (!explicit) {
        return inferred;
    }
    if (
        node.kind === "string" &&
        (explicit === "text" || explicit === "field")
    ) {
        return explicit;
    }
    return explicit === inferred ? explicit : inferred;
}

/** A top-level argument that's a direct member input: its value is exactly `{{key}}`. */
export function isDynamicArg(entry: ArgEntry): boolean {
    return (
        entry.key !== "" &&
        entry.value.kind === "string" &&
        entry.value.value === `{{${entry.key}}}`
    );
}

/** Keys of the arguments configured as direct member inputs (their field config is shown inline). */
export function dynamicArgNames(entries: ArgEntry[]): Set<string> {
    return new Set(entries.filter(isDynamicArg).map((entry) => entry.key));
}

/** A duplicated args key with the dotted path (relative to `args`) of its containing object. */
export interface DuplicateArgKey {
    /** Path to the object that holds the duplicate; `""` for the top-level args object. */
    path: string;
    key: string;
}

/**
 * Keys that appear more than once within the same object level, anywhere in the args tree, each
 * tagged with the path to its containing object so the error can point at the offender. The
 * serializer is last-write-wins, so duplicate keys would silently drop on save; the builder surfaces
 * these so the loss is visible. Blank keys (mid-edit) are not counted.
 */
export function duplicateArgKeys(entries: ArgEntry[]): DuplicateArgKey[] {
    const dupes: DuplicateArgKey[] = [];
    walkEntries(entries, "", dupes);
    return dupes;
}

function walkEntries(
    entries: ArgEntry[],
    path: string,
    dupes: DuplicateArgKey[],
): void {
    const seen = new Set<string>();
    const flagged = new Set<string>();
    for (const entry of entries) {
        if (
            entry.key !== "" &&
            seen.has(entry.key) &&
            !flagged.has(entry.key)
        ) {
            // Report a given key once per object level, however many times it repeats.
            dupes.push({ path, key: entry.key });
            flagged.add(entry.key);
        }
        seen.add(entry.key);
        const childPath = path === "" ? entry.key : `${path}.${entry.key}`;
        walkNode(entry.value, childPath, dupes);
    }
}

function walkNode(node: ArgNode, path: string, dupes: DuplicateArgKey[]): void {
    if (node.kind === "object") {
        walkEntries(node.entries, path, dupes);
    } else if (node.kind === "array") {
        node.items.forEach((item, index) => {
            walkNode(item.value, `${path}.${index}`, dupes);
        });
    }
}

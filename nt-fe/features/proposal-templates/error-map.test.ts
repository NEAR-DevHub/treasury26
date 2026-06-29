import { describe, expect, it } from "bun:test";
import { errorFor, isInlineErrorPath } from "./error-map";

const errors = [
    "id: id must be a tag-safe slug",
    "binding.receiver_id: binding.receiver_id must not be blank",
    "fields.0.name: required",
];

describe("errorFor", () => {
    it("strips the leading field token so the message reads cleanly", () => {
        expect(errorFor(errors, "id")).toBe("Must be a tag-safe slug");
        expect(errorFor(errors, "binding.receiver_id")).toBe(
            "Must not be blank",
        );
    });

    it("capitalizes a message that has no leading field token", () => {
        expect(errorFor(errors, "fields.0.name")).toBe("Required");
    });

    it("strips only a dotted path or meta key, never an ordinary leading word", () => {
        expect(
            errorFor(
                ["binding.gas: binding.gas must be an integer string"],
                "binding.gas",
            ),
        ).toBe("Must be an integer string");
        // a descriptive message with no path token is only capitalized, not mis-stripped
        expect(
            errorFor(
                ["args: references a placeholder no field declares"],
                "args",
            ),
        ).toBe("References a placeholder no field declares");
    });

    it("does not match a different path that shares a prefix", () => {
        expect(errorFor(["icon: bad"], "id")).toBeUndefined();
        // "fields" must not swallow "fields.0.name".
        expect(errorFor(["fields.0.name: x"], "fields")).toBeUndefined();
    });

    it("returns undefined when nothing matches", () => {
        expect(errorFor(errors, "title")).toBeUndefined();
    });
});

describe("isInlineErrorPath", () => {
    it("claims the paths an input actually renders", () => {
        for (const path of [
            "id",
            "title",
            "binding.receiver_id",
            "binding.gas",
            "fields.0.name",
            "fields.2.label",
            "fields.0.validation.min",
            "fields.1.validation.pattern",
            "fields.0.default",
            "fields.0.options",
        ]) {
            expect(isInlineErrorPath(path)).toBe(true);
        }
    });

    it("does NOT claim cross-field refines or the unique-names rule (they need the catch-all)", () => {
        for (const path of [
            "fields", // unique field names
            "fields.0.validation", // min/max cross-bound refine
            "fields.0.required", // `required` on a bool
            "fields.0.type",
            "args",
            "version",
        ]) {
            expect(isInlineErrorPath(path)).toBe(false);
        }
    });
});

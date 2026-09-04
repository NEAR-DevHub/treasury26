import { describe, expect, it } from "bun:test";
import {
    hasInAppHistory,
    shouldShowPageBack,
    trackInAppPath,
} from "./in-app-navigation";

function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() {
            return data.size;
        },
        clear() {
            data.clear();
        },
        getItem(key: string) {
            return data.get(key) ?? null;
        },
        key(index: number) {
            return [...data.keys()][index] ?? null;
        },
        removeItem(key: string) {
            data.delete(key);
        },
        setItem(key: string, value: string) {
            data.set(key, value);
        },
    };
}

describe("in-app navigation", () => {
    it("has no history on the first path in a session", () => {
        const storage = memoryStorage();
        trackInAppPath("/dao/payments", storage);
        expect(
            hasInAppHistory({ storage, referrer: "", origin: "http://app" }),
        ).toBe(false);
    });

    it("records history after moving to a second path", () => {
        const storage = memoryStorage();
        trackInAppPath("/dao", storage);
        trackInAppPath("/dao/payments", storage);
        expect(
            hasInAppHistory({ storage, referrer: "", origin: "http://app" }),
        ).toBe(true);
    });

    it("treats a same-origin referrer as in-app history", () => {
        const storage = memoryStorage();
        expect(
            hasInAppHistory({
                storage,
                referrer: "http://app/dao",
                origin: "http://app",
            }),
        ).toBe(true);
    });

    it("does not create history when the same path is tracked again", () => {
        const storage = memoryStorage();
        trackInAppPath("/dao/payments", storage);
        trackInAppPath("/dao/payments", storage);
        expect(
            hasInAppHistory({ storage, referrer: "", origin: "http://app" }),
        ).toBe(false);
    });

    it("shows nested back on second-level screens", () => {
        expect(
            shouldShowPageBack({
                hasBackButton: true,
                backKind: "nested",
            }),
        ).toBe(true);
    });

    it("never shows section back on top-level destinations", () => {
        expect(
            shouldShowPageBack({
                hasBackButton: true,
                backKind: "section",
            }),
        ).toBe(false);
    });

    it("ignores an external referrer with no prior path", () => {
        const storage = memoryStorage();
        expect(
            hasInAppHistory({
                storage,
                referrer: "https://near.org",
                origin: "http://app",
            }),
        ).toBe(false);
    });
});

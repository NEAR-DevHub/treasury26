import { describe, expect, it } from "bun:test";
import { buildLoginHref, sanitizeReturnTo } from "./auth-redirect";

describe("sanitizeReturnTo", () => {
    it("accepts relative paths with query and hash", () => {
        expect(sanitizeReturnTo("/foo?x=1")).toBe("/foo?x=1");
        expect(sanitizeReturnTo("/a/b")).toBe("/a/b");
        expect(sanitizeReturnTo("/settings?tab=voting#top")).toBe(
            "/settings?tab=voting#top",
        );
    });

    it("rejects absolute and protocol-relative URLs", () => {
        expect(sanitizeReturnTo("https://evil.com")).toBeNull();
        expect(sanitizeReturnTo("http://evil.com/path")).toBeNull();
        expect(sanitizeReturnTo("//evil.com")).toBeNull();
        expect(sanitizeReturnTo("//evil.com/path")).toBeNull();
    });

    it("rejects empty and non-path values", () => {
        expect(sanitizeReturnTo(null)).toBeNull();
        expect(sanitizeReturnTo(undefined)).toBeNull();
        expect(sanitizeReturnTo("")).toBeNull();
        expect(sanitizeReturnTo("foo")).toBeNull();
    });
});

describe("buildLoginHref", () => {
    it("includes a sanitized returnTo", () => {
        expect(buildLoginHref("/dao.near/dashboard", "")).toBe(
            "/login?returnTo=%2Fdao.near%2Fdashboard",
        );
        expect(buildLoginHref("/dao.near/settings", "tab=voting")).toBe(
            "/login?returnTo=%2Fdao.near%2Fsettings%3Ftab%3Dvoting",
        );
    });
});

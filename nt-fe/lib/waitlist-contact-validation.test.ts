import { describe, expect, it } from "bun:test";
import { isValidWaitlistContact } from "./waitlist-contact-validation";

describe("isValidWaitlistContact", () => {
    it("accepts valid email addresses", () => {
        expect(isValidWaitlistContact("user@example.com")).toBe(true);
        expect(isValidWaitlistContact("  user.name+tag@domain.co  ")).toBe(
            true,
        );
    });

    it("accepts valid Telegram usernames with @ prefix", () => {
        expect(isValidWaitlistContact("@username")).toBe(true);
        expect(isValidWaitlistContact("@user_name123")).toBe(true);
    });

    it("rejects Telegram usernames without @ prefix", () => {
        expect(isValidWaitlistContact("username")).toBe(false);
        expect(isValidWaitlistContact("user_name123")).toBe(false);
    });

    it("rejects invalid values", () => {
        expect(isValidWaitlistContact("0")).toBe(false);
        expect(isValidWaitlistContact("12345")).toBe(false);
        expect(isValidWaitlistContact("@abc")).toBe(false);
        expect(isValidWaitlistContact("not-an-email")).toBe(false);
        expect(isValidWaitlistContact("bad@")).toBe(false);
        expect(isValidWaitlistContact("")).toBe(false);
        expect(isValidWaitlistContact("   ")).toBe(false);
    });
});

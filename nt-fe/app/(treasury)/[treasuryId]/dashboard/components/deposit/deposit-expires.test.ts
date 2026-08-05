import { describe, expect, it } from "bun:test";
import {
    DEPOSIT_ADDRESS_VALIDITY_MS,
    DEPOSIT_EXPIRY_URGENT_MS,
    formatDepositRemainingDuration,
    isDepositAddressExpired,
    isDepositAddressUsed,
    isDepositExpiryUrgent,
    resolveExpiresAtMs,
} from "./deposit-expires";

describe("deposit-expires", () => {
    it("marks remaining time under 24 hours as urgent", () => {
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        expect(
            isDepositExpiryUrgent(now + DEPOSIT_EXPIRY_URGENT_MS - 1, now),
        ).toBe(true);
        expect(isDepositExpiryUrgent(now + DEPOSIT_EXPIRY_URGENT_MS, now)).toBe(
            false,
        );
        expect(isDepositExpiryUrgent(now + 2 * 60 * 60 * 1000, now)).toBe(true);
    });

    it("detects expired addresses", () => {
        const now = 1_000_000;
        expect(isDepositAddressExpired(now - 1, now)).toBe(true);
        expect(isDepositAddressExpired(now + 1, now)).toBe(false);
        expect(isDepositAddressExpired(null, now)).toBe(false);
    });

    it("treats non-pending statuses as used", () => {
        expect(isDepositAddressUsed("PENDING_DEPOSIT")).toBe(false);
        expect(isDepositAddressUsed("SUCCESS")).toBe(true);
        expect(isDepositAddressUsed("PROCESSING")).toBe(true);
        expect(isDepositAddressUsed("EXPIRED")).toBe(true);
        expect(isDepositAddressUsed(null)).toBe(false);
    });

    it("resolves expiry from createdAt when expiresAt is missing", () => {
        const createdAt = "2026-01-01T00:00:00.000Z";
        const createdMs = Date.parse(createdAt);
        expect(resolveExpiresAtMs({ expiresAtMs: null, createdAt })).toBe(
            createdMs + DEPOSIT_ADDRESS_VALIDITY_MS,
        );
        expect(
            resolveExpiresAtMs({
                expiresAtMs: createdMs + 1000,
                createdAt,
            }),
        ).toBe(createdMs + 1000);
    });

    it("ceils days so nearly-14-day remaining still shows 14 days", () => {
        const now = Date.UTC(2026, 0, 1, 0, 0, 0);
        // 13 days + 23 hours would floor to 13; ceil keeps 14.
        const almostFourteenDays =
            now + 13 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000;
        expect(
            formatDepositRemainingDuration(almostFourteenDays, "en", now),
        ).toMatch(/14\s+days?/i);

        expect(
            formatDepositRemainingDuration(
                now + 14 * 24 * 60 * 60 * 1000,
                "en",
                now,
            ),
        ).toMatch(/14\s+days?/i);
    });

    it("shows hours under 24h and minutes under 1h", () => {
        const now = Date.UTC(2026, 0, 1, 0, 0, 0);
        expect(
            formatDepositRemainingDuration(
                now + 2 * 60 * 60 * 1000 + 30 * 60 * 1000,
                "en",
                now,
            ),
        ).toMatch(/3\s+hours?/i);

        expect(
            formatDepositRemainingDuration(now + 45 * 60 * 1000, "en", now),
        ).toMatch(/45\s+minutes?/i);

        expect(
            formatDepositRemainingDuration(now + 30 * 1000, "en", now),
        ).toMatch(/1\s+minutes?/i);
    });
});

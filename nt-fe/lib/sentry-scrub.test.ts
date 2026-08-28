import { describe, expect, it } from "bun:test";
import type { Event } from "@sentry/nextjs";
import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
    it("redacts JWTs and sensitive key-values in messages and exceptions", () => {
        const event = scrubSentryEvent({
            message:
                'login failed accessToken="eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkYW8ifQ.signaturevalue1234567890"',
            exception: {
                values: [{ value: "request with token=abc123secret failed" }],
            },
        } as Event);

        expect(event.message).not.toContain("eyJhbGci");
        expect(event.message).toContain("[REDACTED]");
        expect(event.exception?.values?.[0]?.value).not.toContain(
            "abc123secret",
        );
    });

    it("leaves non-JWT dotted strings alone", () => {
        const event = scrubSentryEvent({
            message:
                "failed to resolve bulk-payment-factory.testnet-sandbox.subaccount-name.registrar-contract",
        } as Event);

        expect(event.message).not.toContain("[REDACTED]");
    });

    it("redacts sensitive keys in extra and breadcrumb data, keeps the rest", () => {
        const event = scrubSentryEvent({
            breadcrumbs: [
                {
                    message: "api call",
                    data: { authorization: "Bearer x", daoId: "dao.near" },
                },
            ],
            extra: {
                apiKey: "super-secret",
                payload: { refreshToken: "value", daoId: "dao.near" },
            },
            request: {
                headers: { cookie: "session=abc", accept: "application/json" },
                cookies: { session: "abc" },
            },
        } as Event);

        expect(event.breadcrumbs?.[0]?.data?.authorization).toBe("[REDACTED]");
        expect(event.breadcrumbs?.[0]?.data?.daoId).toBe("dao.near");
        expect(event.extra?.apiKey).toBe("[REDACTED]");
        expect(
            (event.extra?.payload as Record<string, unknown>).refreshToken,
        ).toBe("[REDACTED]");
        expect((event.extra?.payload as Record<string, unknown>).daoId).toBe(
            "dao.near",
        );
        expect(event.request?.headers?.cookie).toBe("[REDACTED]");
        expect(event.request?.headers?.accept).toBe("application/json");
        expect(event.request?.cookies?.session).toBeUndefined();
    });
});

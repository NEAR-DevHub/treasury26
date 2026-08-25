import { describe, expect, it } from "bun:test";
import {
    resolvePreferredMemberTreasuryId,
    resolveTreasuryHomeHref,
} from "./treasury-home";

describe("resolvePreferredMemberTreasuryId", () => {
    it("prefers lastTreasury when the user is still a member", () => {
        expect(
            resolvePreferredMemberTreasuryId(
                [
                    { daoId: "a.near", isMember: true },
                    { daoId: "b.near", isMember: true },
                ],
                "b.near",
            ),
        ).toBe("b.near");
    });

    it("ignores lastTreasury when the user is not a member there", () => {
        expect(
            resolvePreferredMemberTreasuryId(
                [
                    { daoId: "a.near", isMember: true },
                    { daoId: "b.near", isMember: false },
                ],
                "b.near",
            ),
        ).toBe("a.near");
    });

    it("returns null when the user has no memberships", () => {
        expect(
            resolvePreferredMemberTreasuryId(
                [{ daoId: "saved.near", isMember: false }],
                "saved.near",
            ),
        ).toBeNull();
        expect(resolvePreferredMemberTreasuryId([], "gone.near")).toBeNull();
    });
});

describe("resolveTreasuryHomeHref", () => {
    it("routes to the preferred member treasury", () => {
        expect(
            resolveTreasuryHomeHref(
                [{ daoId: "only.near", isMember: true }],
                null,
            ),
        ).toBe("/only.near");
    });

    it("sends users with no memberships to create", () => {
        expect(resolveTreasuryHomeHref([], null)).toBe("/create");
    });
});

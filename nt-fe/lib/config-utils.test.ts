import { describe, expect, it } from "bun:test";
import type { Policy } from "@/types/policy";
import { canChangePolicy, isRequestor } from "./config-utils";

/**
 * The permission tiers behind the Request Templates gates: `canChangePolicy` (author templates,
 * gated on the backend's `ChangePolicy` action) and `isRequestor` (file a request). The two must
 * stay distinct — a proposer is not a manager and vice-versa — or the UI leaks/hides the wrong
 * affordances. These fixtures mirror the on-chain SputnikDAO policy shape nt-be returns.
 */
const ACCOUNT = "member.near";

function policyWith(
    permissions: string[],
    members: string[] = [ACCOUNT],
): Policy {
    return {
        roles: [
            {
                name: "role",
                kind: { Group: members },
                permissions,
                vote_policy: {},
            },
        ],
        default_vote_policy: {
            weight_kind: "RoleWeight",
            quorum: "0",
            threshold: [1, 2],
        },
        proposal_bond: "0",
        proposal_period: "0",
        bounty_bond: "0",
        bounty_forgiveness_period: "0",
    };
}

describe("canChangePolicy (template authoring gate)", () => {
    it("grants on the canonical proposal:ChangePolicy permission", () => {
        expect(
            canChangePolicy(policyWith(["proposal:ChangePolicy"]), ACCOUNT),
        ).toBe(true);
    });

    it("grants on the wildcard action *:ChangePolicy and on *:*", () => {
        expect(canChangePolicy(policyWith(["*:ChangePolicy"]), ACCOUNT)).toBe(
            true,
        );
        expect(canChangePolicy(policyWith(["*:*"]), ACCOUNT)).toBe(true);
    });

    it("denies a pure Requestor (AddProposal is not ChangePolicy)", () => {
        // The load-bearing case: a proposer must NOT see authoring UI.
        expect(canChangePolicy(policyWith(["*:AddProposal"]), ACCOUNT)).toBe(
            false,
        );
        expect(canChangePolicy(policyWith(["call:AddProposal"]), ACCOUNT)).toBe(
            false,
        );
    });

    it("denies a non-member and a null policy", () => {
        expect(
            canChangePolicy(
                policyWith(["*:*"], ["someone-else.near"]),
                ACCOUNT,
            ),
        ).toBe(false);
        expect(canChangePolicy(null, ACCOUNT)).toBe(false);
        expect(canChangePolicy(policyWith(["*:*"]), "")).toBe(false);
    });
});

describe("isRequestor (file-a-request gate)", () => {
    it("grants on call: or transfer:AddProposal (and the wildcard)", () => {
        expect(isRequestor(policyWith(["call:AddProposal"]), ACCOUNT)).toBe(
            true,
        );
        expect(isRequestor(policyWith(["transfer:AddProposal"]), ACCOUNT)).toBe(
            true,
        );
        expect(isRequestor(policyWith(["*:AddProposal"]), ACCOUNT)).toBe(true);
    });

    it("denies a pure manager (ChangePolicy is not AddProposal)", () => {
        expect(isRequestor(policyWith(["*:ChangePolicy"]), ACCOUNT)).toBe(
            false,
        );
    });
});

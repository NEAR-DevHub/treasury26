import { describe, expect, it } from "vitest";
import { resolveProfileImageUrl } from "./profile-image";

describe("resolveProfileImageUrl", () => {
    it("returns string urls", () => {
        expect(resolveProfileImageUrl("https://example.com/a.png")).toBe(
            "https://example.com/a.png",
        );
        expect(resolveProfileImageUrl("  ")).toBeUndefined();
        expect(resolveProfileImageUrl(null)).toBeUndefined();
    });

    it("reads nested url and ipfs cid shapes", () => {
        expect(
            resolveProfileImageUrl({
                url: "https://ipfs.near.social/ipfs/abc",
            }),
        ).toBe("https://ipfs.near.social/ipfs/abc");
        expect(resolveProfileImageUrl({ ipfs_cid: "cid123" })).toBe(
            "https://ipfs.near.social/ipfs/cid123",
        );
        expect(resolveProfileImageUrl({ ipfsCid: "cid456" })).toBe(
            "https://ipfs.near.social/ipfs/cid456",
        );
    });
});

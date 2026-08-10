/**
 * Normalize profile image payloads from NEAR Social / local overrides into a URL.
 */
export function resolveProfileImageUrl(image: unknown): string | undefined {
    if (!image) return undefined;

    if (typeof image === "string") {
        const trimmed = image.trim();
        return trimmed || undefined;
    }

    if (typeof image === "object") {
        const value = image as Record<string, unknown>;
        if (typeof value.url === "string" && value.url.trim()) {
            return value.url.trim();
        }

        const cid = value.ipfs_cid ?? value.ipfsCid;
        if (typeof cid === "string" && cid.trim()) {
            return `https://ipfs.near.social/ipfs/${cid.trim()}`;
        }
    }

    return undefined;
}

/**
 * Safe relative path for post-login redirects.
 * Accepts only same-origin pathnames (leading `/`), rejects absolute and
 * protocol-relative URLs that could open an external site.
 */
export function sanitizeReturnTo(
    raw: string | null | undefined,
): string | null {
    if (!raw) return null;
    if (!raw.startsWith("/")) return null;
    // Protocol-relative: `//evil.com`
    if (raw.startsWith("//")) return null;
    return raw;
}

/** Build `/login?returnTo=...` for the current path + query. */
export function buildLoginHref(pathname: string, search: string): string {
    const candidate = search ? `${pathname}?${search}` : pathname;
    const returnTo = sanitizeReturnTo(candidate);
    const params = new URLSearchParams();
    if (returnTo) params.set("returnTo", returnTo);
    const query = params.toString();
    return query ? `/login?${query}` : "/login";
}

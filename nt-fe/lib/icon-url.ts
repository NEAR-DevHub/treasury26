/** True when `icon` is a loadable image URL (http(s), data URI, or site path). */
export function isIconUrl(icon?: string | null): boolean {
    return (
        !!icon &&
        (icon.startsWith("http") ||
            icon.startsWith("data:") ||
            icon.startsWith("/"))
    );
}

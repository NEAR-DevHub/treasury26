const PATH_KEY = "treasury26:nav-path";
const PREV_KEY = "treasury26:nav-prev";

function getSessionStorage(): Storage | null {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
}

/** Record the current path so later pages know the user moved inside the app. */
export function trackInAppPath(
    pathname: string,
    storage: Storage | null = getSessionStorage(),
): void {
    if (!storage) return;
    const current = storage.getItem(PATH_KEY);
    if (current && current !== pathname) {
        storage.setItem(PREV_KEY, current);
    }
    storage.setItem(PATH_KEY, pathname);
}

/** Nested pages always show back; section pages only after an in-app hop. */
export function shouldShowPageBack(options: {
    hasBackButton: boolean;
    backKind: "section" | "nested";
    cameFromApp: boolean;
}): boolean {
    if (!options.hasBackButton) return false;
    if (options.backKind === "nested") return true;
    return options.cameFromApp;
}

/**
 * True when this session already visited another app path, or the document
 * was opened from a same-origin page (in-app link / refresh after navigating).
 */
export function hasInAppHistory(options?: {
    referrer?: string;
    origin?: string;
    storage?: Storage | null;
}): boolean {
    const storage = options?.storage ?? getSessionStorage();
    if (storage?.getItem(PREV_KEY)) return true;

    const referrer =
        options?.referrer ??
        (typeof document !== "undefined" ? document.referrer : "");
    const origin =
        options?.origin ??
        (typeof window !== "undefined" ? window.location.origin : "");
    if (!referrer || !origin) return false;
    try {
        return new URL(referrer).origin === origin;
    } catch {
        return false;
    }
}

import { useState, useEffect } from "react";

/**
 * Detect whether a CSS media query currently matches.
 * Initializes synchronously on the client to avoid a false → true flip after mount.
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => {
        if (typeof window === "undefined") return false;
        return window.matchMedia(query).matches;
    });

    useEffect(() => {
        const media = window.matchMedia(query);
        const listener = (event: MediaQueryListEvent) => {
            setMatches(event.matches);
        };

        setMatches(media.matches);

        // Safari < 14 only supports the older addListener/removeListener API.
        if (typeof media.addEventListener === "function") {
            media.addEventListener("change", listener);
            return () => media.removeEventListener("change", listener);
        }

        media.addListener(listener);
        return () => media.removeListener(listener);
    }, [query]);

    return matches;
}

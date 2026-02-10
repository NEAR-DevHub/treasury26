import { useState, useEffect } from "react";

/**
 * Custom hook to detect media query matches
 * @param query - CSS media query string (e.g., "(max-width: 768px)")
 * @returns boolean indicating if the query matches
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(false);

    useEffect(() => {
        const media = window.matchMedia(query);

        // Set initial value
        setMatches(media.matches);

        // Create event listener
        const listener = (event: MediaQueryListEvent) => {
            setMatches(event.matches);
        };

        // Add listener (use deprecated addListener for older browsers)
        if (media.addEventListener) {
            media.addEventListener("change", listener);
        } else {
            // @ts-ignore - for older browsers
            media.addListener(listener);
        }

        // Cleanup
        return () => {
            if (media.removeEventListener) {
                media.removeEventListener("change", listener);
            } else {
                // @ts-ignore - for older browsers
                media.removeListener(listener);
            }
        };
    }, [query]);

    return matches;
}


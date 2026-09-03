"use client";

import { useEffect, useState } from "react";

/**
 * Tracks img load success/failure and resets when `src` changes so a failed
 * or in-flight prior selection cannot keep painting after the user picks
 * another icon.
 */
export function useImageLoadError(src?: string | null) {
    const [hasError, setHasError] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);

    useEffect(() => {
        setHasError(false);
        setHasLoaded(false);
    }, [src]);

    return {
        showImage: !!src && !hasError,
        isLoading: !!src && !hasError && !hasLoaded,
        onError: () => setHasError(true),
        onLoad: () => setHasLoaded(true),
    };
}

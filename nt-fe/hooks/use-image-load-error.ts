"use client";

import { useState } from "react";

/**
 * Tracks img load success/failure per `src`, so a failed or in-flight prior
 * selection cannot keep painting after the user picks another icon. The state
 * is keyed by the src rather than reset in an effect, which would leave one
 * committed render describing the previous image.
 */
export function useImageLoadError(src?: string | null) {
    const [erroredSrc, setErroredSrc] = useState<string | null>(null);
    const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

    const hasError = !!src && erroredSrc === src;
    const hasLoaded = !!src && loadedSrc === src;

    return {
        showImage: !!src && !hasError,
        isLoading: !!src && !hasError && !hasLoaded,
        onError: () => setErroredSrc(src ?? null),
        onLoad: () => setLoadedSrc(src ?? null),
    };
}

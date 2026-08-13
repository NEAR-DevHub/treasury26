"use client";

import { useEffect, useState } from "react";

/**
 * Tracks img load failure and resets when `src` changes so a failed prior
 * selection cannot keep painting after the user picks another icon.
 */
export function useImageLoadError(src?: string | null) {
    const [hasError, setHasError] = useState(false);

    useEffect(() => {
        setHasError(false);
    }, [src]);

    return {
        showImage: !!src && !hasError,
        onError: () => setHasError(true),
    };
}

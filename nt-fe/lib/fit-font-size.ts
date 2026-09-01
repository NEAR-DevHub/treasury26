/** Shrink a measured line from `maxSize` down to `minSize`; then it must truncate. */
export function fitFontSize(options: {
    contentWidth: number;
    availableWidth: number;
    maxSize: number;
    minSize: number;
}): { fontSize: number; truncated: boolean } {
    const { contentWidth, availableWidth, maxSize, minSize } = options;
    if (availableWidth <= 0 || contentWidth <= 0) {
        return { fontSize: maxSize, truncated: false };
    }
    if (contentWidth <= availableWidth) {
        return { fontSize: maxSize, truncated: false };
    }
    const scaled = Math.floor((availableWidth / contentWidth) * maxSize);
    if (scaled >= minSize) {
        return { fontSize: Math.max(minSize, scaled), truncated: false };
    }
    return { fontSize: minSize, truncated: true };
}

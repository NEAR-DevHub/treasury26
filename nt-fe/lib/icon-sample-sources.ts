/** Width to ask the optimizer for. Must be one of Next's `imageSizes`. */
const SAMPLE_WIDTH = 32;

/**
 * URLs to try, in order, when reading an icon's pixels through a canvas.
 *
 * Reading pixels requires the image to be same-origin or CORS-enabled. Most
 * icon CDNs send no `Access-Control-Allow-Origin`, so remote art is first
 * requested through Next's image optimizer, which re-serves it from our own
 * origin. The optimizer rejects SVG (we leave `dangerouslyAllowSVG` off), so
 * the icon URL itself is kept as a fallback for hosts that do allow CORS.
 */
export function iconSampleSources(url: string): string[] {
    if (url.startsWith("data:") || url.startsWith("/")) return [url];

    return [
        `/_next/image?url=${encodeURIComponent(url)}&w=${SAMPLE_WIDTH}&q=75`,
        // A plain `<img>` elsewhere on the page may already have cached this
        // icon without CORS headers; a distinct query avoids that entry.
        `${url}${url.includes("?") ? "&" : "?"}accent=1`,
    ];
}

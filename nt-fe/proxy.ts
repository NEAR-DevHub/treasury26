import { type NextRequest, NextResponse } from "next/server";
import geoip from "geoip-lite";
import {
    SANCTIONED_COUNTRY_CODES,
    SANCTIONED_REGIONS,
} from "@/constants/sanctioned-countries";
import {
    LOCALE_COOKIE,
    isEnabledLocale,
    pickLocaleFromAcceptLanguage,
} from "@/i18n/config";

const ATTRIBUTION_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
] as const;

/**
 * Extract the client's real IP address from request headers.
 */
function getClientIp(request: NextRequest): string | null {
    // X-Real-IP (set by reverse proxies including Render)
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp.trim();

    // X-Forwarded-For (leftmost = original client)
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
        const first = forwarded.split(",")[0];
        if (first) return first.trim();
    }

    return null;
}

/**
 * Determine country and region from the request using geoip-lite.
 */
function getGeoInfo(request: NextRequest): {
    countryCode: string | null;
    regionCode: string | null;
} {
    const clientIp = getClientIp(request);
    if (!clientIp) {
        return { countryCode: null, regionCode: null };
    }

    const geo = geoip.lookup(clientIp);
    if (geo) {
        return {
            countryCode: geo.country ?? null,
            regionCode: geo.region ?? null,
        };
    }

    return { countryCode: null, regionCode: null };
}

/**
 * Check if the resolved geo information indicates a sanctioned location.
 */
function isSanctionedLocation(
    countryCode: string | null,
    regionCode: string | null,
): boolean {
    if (!countryCode) return false;

    if (SANCTIONED_COUNTRY_CODES.has(countryCode)) {
        return true;
    }

    // Sub-national region check (e.g., Crimea, Donetsk, Luhansk under UA)
    if (regionCode) {
        const sanctionedRegions = SANCTIONED_REGIONS.get(countryCode);
        if (sanctionedRegions?.has(regionCode)) {
            return true;
        }
    }

    return false;
}

function appendLoginAttributionFromReturnTo(request: NextRequest) {
    if (request.nextUrl.pathname !== "/login") return null;

    const loginUrl = request.nextUrl.clone();
    const searchParams = loginUrl.searchParams;
    const hasTopLevelAttribution = ATTRIBUTION_KEYS.some((key) =>
        searchParams.has(key),
    );
    if (hasTopLevelAttribution) return null;

    const returnTo = searchParams.get("returnTo");
    if (!returnTo) return null;

    let returnToUrl: URL;
    try {
        returnToUrl = new URL(returnTo, loginUrl.origin);
    } catch {
        return null;
    }

    let hasChanges = false;
    for (const key of ATTRIBUTION_KEYS) {
        const value = returnToUrl.searchParams.get(key);
        if (!value || searchParams.has(key)) continue;
        searchParams.set(key, value);
        hasChanges = true;
    }

    if (!hasChanges) return null;
    return NextResponse.redirect(loginUrl);
}

export function proxy(request: NextRequest) {
    const attributionRedirect = appendLoginAttributionFromReturnTo(request);
    if (attributionRedirect) return attributionRedirect;

    const { countryCode, regionCode } = getGeoInfo(request);

    if (isSanctionedLocation(countryCode, regionCode)) {
        // Rewrite (not redirect) to /blocked — serves blocked page content
        // without changing URL, preventing redirect loops
        const blockedUrl = new URL("/blocked", request.url);
        return NextResponse.rewrite(blockedUrl);
    }

    const response = NextResponse.next();
    const existingLocale = request.cookies.get(LOCALE_COOKIE)?.value;
    if (!isEnabledLocale(existingLocale)) {
        const detected = pickLocaleFromAcceptLanguage(
            request.headers.get("accept-language"),
        );
        response.cookies.set(LOCALE_COOKIE, detected, {
            path: "/",
            maxAge: 60 * 60 * 24 * 365,
            sameSite: "lax",
            secure: request.nextUrl.protocol === "https:",
        });
    }
    return response;
}

/**
 * Run proxy on all routes except:
 * - /blocked (the blocked page itself)
 * - /crash-report (Sentry proxy)
 * - /_next/static, /_next/image, /_next/data (Next.js internals)
 * - Static files with common extensions
 */
export const config = {
    matcher: [
        "/((?!blocked|crash-report|_next/static|_next/image|_next/data|favicon\\.ico|.*\\.svg$|.*\\.png$|.*\\.jpg$|.*\\.webp$).*)",
    ],
};

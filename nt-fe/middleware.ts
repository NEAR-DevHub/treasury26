import { type NextRequest, NextResponse } from "next/server";
import {
  SANCTIONED_COUNTRY_CODES,
  SANCTIONED_REGIONS,
} from "@/constants/sanctioned-countries";

// Node.js runtime required: geoip-lite uses fs to load its binary database.
// This works in standalone mode on Render.com (standard Node.js server).
export const runtime = "nodejs";

/**
 * Extract the client's real IP address from request headers.
 * Priority reflects trust level of each header source.
 */
function getClientIp(request: NextRequest): string | null {
  // Cloudflare's connecting IP (most trusted when CF is in front)
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

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
 * Determine country and region from the request.
 * Layer 1: Cloudflare CF-IPCountry header (zero-latency, most reliable)
 * Layer 2: geoip-lite local database fallback
 */
function getGeoInfo(request: NextRequest): {
  countryCode: string | null;
  regionCode: string | null;
} {
  // Layer 1: Cloudflare header
  const cfCountry = request.headers.get("cf-ipcountry");
  if (cfCountry && cfCountry !== "XX" && cfCountry !== "T1") {
    const cfRegion = request.headers.get("cf-region-code");
    return {
      countryCode: cfCountry.toUpperCase(),
      regionCode: cfRegion?.toUpperCase() ?? null,
    };
  }

  // Layer 2: geoip-lite fallback
  const clientIp = getClientIp(request);
  if (!clientIp) {
    return { countryCode: null, regionCode: null };
  }

  try {
    // Dynamic require — geoip-lite caches the database after first load
    const geoip = require("geoip-lite") as typeof import("geoip-lite");
    const geo = geoip.lookup(clientIp);
    if (geo) {
      return {
        countryCode: geo.country ?? null,
        regionCode: geo.region ?? null,
      };
    }
  } catch (error) {
    console.error("[geoblocking] geoip-lite lookup failed:", error);
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

export function middleware(request: NextRequest) {
  const { countryCode, regionCode } = getGeoInfo(request);

  if (isSanctionedLocation(countryCode, regionCode)) {
    // Rewrite (not redirect) to /blocked — serves blocked page content
    // without changing URL, preventing redirect loops
    const blockedUrl = new URL("/blocked", request.url);
    return NextResponse.rewrite(blockedUrl);
  }

  return NextResponse.next();
}

/**
 * Run middleware on all routes except:
 * - /blocked (the blocked page itself)
 * - /_next/static, /_next/image, /_next/data (Next.js internals)
 * - Static files with common extensions
 */
export const config = {
  matcher: [
    "/((?!blocked|_next/static|_next/image|_next/data|favicon\\.ico|.*\\.svg$|.*\\.png$|.*\\.jpg$|.*\\.webp$).*)",
  ],
};

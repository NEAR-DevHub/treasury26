import { NextRequest, NextResponse } from "next/server";

const ATTRIBUTION_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
] as const;

export function middleware(request: NextRequest) {
    if (request.nextUrl.pathname !== "/login") {
        return NextResponse.next();
    }

    const loginUrl = request.nextUrl.clone();
    const searchParams = loginUrl.searchParams;

    const hasTopLevelAttribution = ATTRIBUTION_KEYS.some((key) =>
        searchParams.has(key),
    );
    if (hasTopLevelAttribution) {
        return NextResponse.next();
    }

    const returnTo = searchParams.get("returnTo");
    if (!returnTo) {
        return NextResponse.next();
    }

    let returnToUrl: URL;
    try {
        returnToUrl = new URL(returnTo, loginUrl.origin);
    } catch {
        return NextResponse.next();
    }

    let hasChanges = false;
    for (const key of ATTRIBUTION_KEYS) {
        const value = returnToUrl.searchParams.get(key);
        if (!value || searchParams.has(key)) continue;
        searchParams.set(key, value);
        hasChanges = true;
    }

    if (!hasChanges) {
        return NextResponse.next();
    }

    return NextResponse.redirect(loginUrl);
}

export const config = {
    matcher: ["/login"],
};

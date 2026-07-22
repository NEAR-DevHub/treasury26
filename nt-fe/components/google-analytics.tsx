"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";
import { Suspense, useEffect } from "react";

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

declare global {
    interface Window {
        dataLayer?: Record<string, unknown>[];
        gtag?: (...args: unknown[]) => void;
    }
}

function GoogleAnalyticsPageTracker() {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const query = searchParams.toString();

    useEffect(() => {
        if (!GA_MEASUREMENT_ID) return;

        const pagePath = query ? `${pathname}?${query}` : pathname;
        window.gtag?.("event", "page_view", {
            page_path: pagePath,
            send_to: GA_MEASUREMENT_ID,
        });
    }, [pathname, query]);

    return null;
}

export function GoogleAnalytics() {
    if (!GA_MEASUREMENT_ID) {
        return null;
    }

    return (
        <>
            <Script
                src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
                strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
                {`
                  window.dataLayer = window.dataLayer || [];
                  function gtag(){dataLayer.push(arguments);}
                  window.gtag = gtag;
                  gtag('js', new Date());
                  gtag('config', '${GA_MEASUREMENT_ID}', { send_page_view: false });
                `}
            </Script>
            <Suspense fallback={null}>
                <GoogleAnalyticsPageTracker />
            </Suspense>
        </>
    );
}

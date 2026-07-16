"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";
import { Suspense, useEffect } from "react";

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID;

declare global {
    interface Window {
        dataLayer?: Record<string, unknown>[];
    }
}

function GoogleTagManagerPageTracker() {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const query = searchParams.toString();

    useEffect(() => {
        if (!GTM_ID) return;

        const pagePath = query ? `${pathname}?${query}` : pathname;
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
            event: "page_view",
            page_path: pagePath,
        });
    }, [pathname, query]);

    return null;
}

export function GoogleTagManager() {
    if (!GTM_ID) {
        return null;
    }

    return (
        <>
            <Script id="google-tag-manager" strategy="afterInteractive">
                {`
                  (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
                  new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
                  j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
                  'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
                  })(window,document,'script','dataLayer','${GTM_ID}');
                `}
            </Script>
            <noscript>
                <iframe
                    title="Google Tag Manager"
                    src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
                    height="0"
                    width="0"
                    style={{ display: "none", visibility: "hidden" }}
                />
            </noscript>
            <Suspense fallback={null}>
                <GoogleTagManagerPageTracker />
            </Suspense>
        </>
    );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import { PageComponentLayout } from "@/components/page-component-layout";
import { sanitizeReturnTo } from "@/lib/auth-redirect";
import { useNear } from "@/stores/near-store";

const UTM_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
] as const;

function appendUtmParamsToReturnTo(
    returnTo: string,
    searchParams: ReturnType<typeof useSearchParams>,
): string {
    const url = new URL(returnTo, "https://trezu.app");
    let hasChanges = false;

    for (const key of UTM_KEYS) {
        const utmValue = searchParams.get(key);
        if (!utmValue || url.searchParams.has(key)) continue;
        url.searchParams.set(key, utmValue);
        hasChanges = true;
    }

    if (!hasChanges) return returnTo;
    return `${url.pathname}${url.search}${url.hash}`;
}

export default function LoginPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { accountId, connect, isAuthenticating } = useNear();

    // A bare /login has nowhere specific to go back to, so a signed-in user
    // lands on the root, which forwards them to their treasury or to /create.
    const returnTo = sanitizeReturnTo(searchParams.get("returnTo")) ?? "/";
    const redirectTarget = useMemo(
        () => appendUtmParamsToReturnTo(returnTo, searchParams),
        [returnTo, searchParams],
    );

    useEffect(() => {
        if (!accountId) return;
        router.replace(redirectTarget);
    }, [accountId, redirectTarget, router]);

    return (
        <PageComponentLayout
            title="Near Business"
            hideLogin
            hideCollapseButton
            hideAppWarningBanner
            transparentHeader
            hideHeaderBottomBorder
            hideHeaderContent
            fitViewport
            mainClassName="flex flex-col bg-general-bg-tertiary pt-1"
        >
            <div className="mx-auto w-full max-w-[448px] space-y-3 md:mt-3">
                <ConnectWalletSelector
                    source="/login"
                    connectFlow="within_treasury"
                    isConnectingWallet={isAuthenticating}
                    onConnectSupported={connect}
                />
            </div>
        </PageComponentLayout>
    );
}

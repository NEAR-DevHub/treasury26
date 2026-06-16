"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import Logo from "@/components/icons/logo";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useNear } from "@/stores/near-store";

const UTM_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
] as const;

function sanitizeReturnTo(raw: string | null): string | null {
    if (!raw) return null;
    if (!raw.startsWith("/")) return null;
    return raw;
}

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

    const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
    const shouldShowCreateTreasuryCta = !returnTo || returnTo === "/";
    const returnToWithUtms = useMemo(
        () =>
            returnTo ? appendUtmParamsToReturnTo(returnTo, searchParams) : null,
        [returnTo, searchParams],
    );
    const loginHeaderLogo = <Logo size="sm" />;

    useEffect(() => {
        if (!accountId) return;

        if (returnToWithUtms) {
            router.replace(returnToWithUtms);
        }
    }, [accountId, returnToWithUtms, router]);

    return (
        <PageComponentLayout
            title="Trezu"
            hideLogin
            hideCollapseButton
            transparentHeader
            logo={loginHeaderLogo}
        >
            <div className="mx-auto mt-6 max-w-[668px] md:mt-8">
                <ConnectWalletSelector
                    source="/login"
                    connectFlow="within_treasury"
                    isConnectingWallet={isAuthenticating}
                    showCreateTreasuryCta={shouldShowCreateTreasuryCta}
                    onBack={() => {
                        if (returnToWithUtms) {
                            router.push(returnToWithUtms);
                            return;
                        }
                        router.back();
                    }}
                    onConnectSupported={connect}
                />
            </div>
        </PageComponentLayout>
    );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import Logo from "@/components/icons/logo";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";
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
    const { treasuries, lastTreasuryId, isLoading } = useTreasury();

    const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
    const returnToWithUtms = useMemo(
        () =>
            returnTo ? appendUtmParamsToReturnTo(returnTo, searchParams) : null,
        [returnTo, searchParams],
    );
    const context = searchParams.get("context");
    const connectFlow: "onboarding" | "within_treasury" =
        context === "onboarding" ? "onboarding" : "within_treasury";
    const loginHeaderLogo = <Logo size="sm" />;
    const preferredTreasuryId =
        (lastTreasuryId &&
            treasuries.some((treasury) => treasury.daoId === lastTreasuryId) &&
            lastTreasuryId) ||
        treasuries[0]?.daoId;

    useEffect(() => {
        if (!accountId) return;

        if (returnToWithUtms) {
            router.replace(returnToWithUtms);
            return;
        }

        if (connectFlow === "onboarding") {
            if (isLoading) return;
            if (preferredTreasuryId) {
                trackEvent("existing_user_treasury_opened", {
                    source: "/login",
                    treasury_id: preferredTreasuryId,
                });
                router.replace(`/${preferredTreasuryId}`);
                return;
            }

            router.replace("/");
        }
    }, [
        accountId,
        connectFlow,
        isLoading,
        preferredTreasuryId,
        returnToWithUtms,
        router,
    ]);

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
                    connectFlow={connectFlow}
                    isConnectingWallet={isAuthenticating}
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

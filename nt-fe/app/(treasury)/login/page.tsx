"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";
import { useNear } from "@/stores/near-store";

function sanitizeReturnTo(raw: string | null): string {
    if (!raw) return "/";
    if (!raw.startsWith("/")) return "/";
    return raw;
}

export default function LoginPage() {
    const tSignIn = useTranslations("signIn");
    const tCreate = useTranslations("createTreasury");
    const router = useRouter();
    const searchParams = useSearchParams();
    const { accountId, connect, isAuthenticating } = useNear();
    const { treasuries, lastTreasuryId, isLoading } = useTreasury();

    const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
    const context = searchParams.get("context");
    const connectFlow: "new_user" | "existing_user" | "within_treasury" =
        context === "existing_user" ? "existing_user" : "within_treasury";
    const preferredTreasuryId =
        (lastTreasuryId &&
            treasuries.some((treasury) => treasury.daoId === lastTreasuryId) &&
            lastTreasuryId) ||
        treasuries[0]?.daoId;

    const connectTitle = useMemo(() => {
        if (context === "create_treasury")
            return tCreate("connectWalletCreate");
        return `${tSignIn("connect")} ${tSignIn("wallet")}`;
    }, [context, tCreate, tSignIn]);

    useEffect(() => {
        if (!accountId) return;

        if (context !== "existing_user") {
            router.replace(returnTo);
            return;
        }

        if (isLoading) return;

        if (preferredTreasuryId) {
            trackEvent("existing_user_treasury_opened", {
                source: "/login",
                treasury_id: preferredTreasuryId,
            });
            router.replace(`/${preferredTreasuryId}`);
        }
    }, [accountId, context, isLoading, preferredTreasuryId, returnTo, router]);

    return (
        <PageComponentLayout title={connectTitle} hideLogin hideCollapseButton>
            <div className="mx-auto max-w-[668px]">
                <ConnectWalletSelector
                    title={connectTitle}
                    source="/login"
                    connectFlow={connectFlow}
                    isConnectingWallet={isAuthenticating}
                    onBack={() => router.back()}
                    onConnectSupported={connect}
                />
            </div>
        </PageComponentLayout>
    );
}

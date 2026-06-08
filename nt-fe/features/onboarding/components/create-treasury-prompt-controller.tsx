"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryCreationStatus } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import { useNear } from "@/stores/near-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { CreateTreasuryPromptModal } from "./create-treasury-prompt-modal";

function hasDaoLikeSegment(path: string | null | undefined): boolean {
    if (!path) return false;
    const normalizedPath = (() => {
        try {
            return decodeURIComponent(path);
        } catch {
            return path;
        }
    })();
    return normalizedPath
        .split("/")
        .filter(Boolean)
        .some((segment) => segment.includes(".near"));
}

export function CreateTreasuryPromptController() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [open, setOpen] = useState(false);
    const lastHandledOpenRequestIdRef = useRef(0);
    const prevIsAuthenticatingRef = useRef(false);
    const justAuthenticatedRef = useRef(false);
    const prevAccountIdRef = useRef(false);
    const lastHandledLoginNonceRef = useRef(0);
    const [loginNonce, setLoginNonce] = useState(0);
    const { accountId, isInitializing, isAuthenticating, disconnect } =
        useNear();
    const createTreasuryPromptOpenRequestId = useOnboardingStore(
        (state) => state.createTreasuryPromptOpenRequestId,
    );
    const { treasuries, isLoading } = useTreasury();
    const { data: creationStatus } = useTreasuryCreationStatus();

    const creationAvailable = creationStatus?.creationAvailable ?? true;
    const isOnboardingContext =
        pathname === "/" ||
        (pathname === "/login" &&
            searchParams.get("context") === "existing_user");
    const shouldHideDisconnect =
        hasDaoLikeSegment(pathname) ||
        hasDaoLikeSegment(searchParams.get("returnTo"));
    const canOpenPrompt =
        !!accountId &&
        creationAvailable &&
        !isInitializing &&
        !isLoading &&
        treasuries.length === 0;
    const showDisconnectWallet = canOpenPrompt && !shouldHideDisconnect;

    useEffect(() => {
        if (!accountId) {
            lastHandledOpenRequestIdRef.current = 0;
            lastHandledLoginNonceRef.current = 0;
            setLoginNonce(0);
            setOpen(false);
        }
    }, [accountId]);

    useEffect(() => {
        // Remember when the sign-in flow finishes. On first login `accountId`
        // isn't available yet (it's gated on accepting terms), so we keep this
        // flag until `accountId` materializes after the terms modal.
        if (prevIsAuthenticatingRef.current && !isAuthenticating) {
            justAuthenticatedRef.current = true;
        }
        prevIsAuthenticatingRef.current = isAuthenticating;

        const accountIdAvailable = !!accountId;
        const justGotAccountId =
            !prevAccountIdRef.current && accountIdAvailable;
        prevAccountIdRef.current = accountIdAvailable;

        // Open the prompt once a freshly-authenticated user has an accountId —
        // i.e. right after the wallet connects, or after accepting terms on
        // first login. A plain page reload never sets `justAuthenticatedRef`, so
        // the prompt won't auto-open on refresh.
        if (justAuthenticatedRef.current && justGotAccountId) {
            justAuthenticatedRef.current = false;
            setLoginNonce((prev) => prev + 1);
        }
    }, [isAuthenticating, accountId]);

    useEffect(() => {
        if (!canOpenPrompt) {
            if (!isOnboardingContext) {
                setOpen(false);
            }
            return;
        }

        if (loginNonce > 0 && lastHandledLoginNonceRef.current !== loginNonce) {
            lastHandledLoginNonceRef.current = loginNonce;
            openPrompt();
        }
    }, [canOpenPrompt, isOnboardingContext, loginNonce]);

    useEffect(() => {
        if (!canOpenPrompt) {
            if (!isOnboardingContext) {
                setOpen(false);
            }
            return;
        }

        if (
            createTreasuryPromptOpenRequestId >
            lastHandledOpenRequestIdRef.current
        ) {
            lastHandledOpenRequestIdRef.current =
                createTreasuryPromptOpenRequestId;
            openPrompt();
        }
    }, [canOpenPrompt, isOnboardingContext, createTreasuryPromptOpenRequestId]);

    const source = isOnboardingContext ? "onboarding" : "app";

    const openPrompt = () => {
        setOpen(true);
        trackEvent("create-treasury-prompt-shown", { source });
    };

    const handleOpenChange = (nextOpen: boolean) => setOpen(nextOpen);

    return (
        <CreateTreasuryPromptModal
            open={open}
            source={source}
            showDisconnectWallet={showDisconnectWallet}
            onOpenChange={handleOpenChange}
            onCreateTreasury={() => {
                handleOpenChange(false);
                router.push("/app/new");
            }}
            onDisconnectWallet={async () => {
                await disconnect();
                handleOpenChange(false);
            }}
        />
    );
}

"use client";

import { useEffect, useState } from "react";
import { useNearStore } from "@/stores/near-store";
import { AcceptTermsModal } from "./accept-terms-modal";
import { CreateTreasuryPromptController } from "@/features/onboarding/components/create-treasury-prompt-controller";
import { LoadingScreen } from "./loading-screen";

interface AuthProviderProps {
    children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
    const { isInitializing, isAuthenticated, hasAcceptedTerms, checkAuth } =
        useNearStore();

    const [hasCheckedAuth, setHasCheckedAuth] = useState(false);

    // Check existing auth on mount
    useEffect(() => {
        const check = async () => {
            await checkAuth();
            setHasCheckedAuth(true);
        };
        check();
    }, [checkAuth]);

    // Show loading state while checking auth
    if (!hasCheckedAuth || isInitializing) {
        return <LoadingScreen />;
    }

    // Show terms modal if authenticated but terms not accepted
    const showTermsModal = isAuthenticated && !hasAcceptedTerms;

    return (
        <>
            {children}
            <AcceptTermsModal open={showTermsModal} />
            <CreateTreasuryPromptController />
        </>
    );
}

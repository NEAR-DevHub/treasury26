"use client";

import { useEffect, useState } from "react";
import { useNearStore } from "@/stores/near-store";
import { AcceptTermsModal } from "./accept-terms-modal";
import { CreateTreasuryPromptController } from "@/features/onboarding/components/create-treasury-prompt-controller";
import { LoadingScreen } from "./loading-screen";
import { useConnectorPopupVisible } from "./modal";

interface AuthProviderProps {
    children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
    const {
        isInitializing,
        isAuthenticated,
        hasAcceptedTerms,
        checkAuth,
        user,
    } = useNearStore();

    const [hasCheckedAuth, setHasCheckedAuth] = useState(false);
    const connectorPopupVisible = useConnectorPopupVisible();

    useEffect(() => {
        const check = async () => {
            await checkAuth();
            setHasCheckedAuth(true);
        };
        check();
    }, [checkAuth]);

    if (!hasCheckedAuth || isInitializing) {
        return <LoadingScreen />;
    }

    const showTermsModal =
        isAuthenticated && !hasAcceptedTerms && !connectorPopupVisible;

    return (
        <>
            {children}
            <AcceptTermsModal
                open={showTermsModal}
                variant={user?.hasAcceptedV1Terms ? "returning" : "firstTime"}
            />
            <CreateTreasuryPromptController />
        </>
    );
}

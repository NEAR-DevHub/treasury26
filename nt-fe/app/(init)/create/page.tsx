import { AuthProvider } from "@/components/auth-provider";
import { NearInitializer } from "@/components/near-initializer";
import { RequireAuth } from "@/components/require-auth";
import { TreasuryOnboardingPage } from "@/features/onboarding/components/create-treasury-entry";

export default function CreatePage() {
    return (
        <>
            <NearInitializer />
            <AuthProvider>
                <RequireAuth>
                    <TreasuryOnboardingPage initialScreen="create" />
                </RequireAuth>
            </AuthProvider>
        </>
    );
}

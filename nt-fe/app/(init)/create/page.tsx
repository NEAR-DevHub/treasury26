import { AuthProvider } from "@/components/auth-provider";
import { NearInitializer } from "@/components/near-initializer";
import { TreasuryOnboardingPage } from "@/features/onboarding/components/create-treasury-entry";

export default function CreatePage() {
    return (
        <>
            <NearInitializer />
            <AuthProvider>
                <TreasuryOnboardingPage initialScreen="create" />
            </AuthProvider>
        </>
    );
}

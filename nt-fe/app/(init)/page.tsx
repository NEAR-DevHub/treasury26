import { AuthProvider } from "@/components/auth-provider";
import { NearInitializer } from "@/components/near-initializer";
import { QueryProvider } from "@/components/query-provider";
import { WarningsProvider } from "@/components/warnings-provider";
import { TreasuryOnboardingPage } from "@/features/onboarding/components/create-treasury-entry";

export default function Page() {
    return (
        <QueryProvider>
            <WarningsProvider>
                <NearInitializer />
                <AuthProvider>
                    <TreasuryOnboardingPage initialScreen="login" />
                </AuthProvider>
            </WarningsProvider>
        </QueryProvider>
    );
}

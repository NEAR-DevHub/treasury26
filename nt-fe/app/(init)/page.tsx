import { AuthProvider } from "@/components/auth-provider";
import { NearInitializer } from "@/components/near-initializer";
import { QueryProvider } from "@/components/query-provider";
import { CreateTreasuryEntry } from "@/features/onboarding/components/create-treasury-entry";

export default function Page() {
    return (
        <QueryProvider>
            <NearInitializer />
            <AuthProvider>
                <CreateTreasuryEntry />
            </AuthProvider>
        </QueryProvider>
    );
}

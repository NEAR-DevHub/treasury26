"use client";

import { QueryProvider } from "@/components/query-provider";
import { NearInitializer } from "@/components/near-initializer";
import { AuthProvider } from "@/components/auth-provider";

export default function AppLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <QueryProvider>
            <NearInitializer />
            <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
    );
}

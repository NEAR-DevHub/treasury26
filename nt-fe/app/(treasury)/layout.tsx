import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "../globals.css";
import { NearInitializer } from "@/components/near-initializer";
import { QueryProvider } from "@/components/query-provider";
import { Toaster } from "@/components/toaster";
import { TOURS } from "@/features/onboarding/steps";
import { TourProvider } from "@/features/onboarding/components/tour-provider";
import { AuthProvider } from "@/components/auth-provider";

const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export const metadata: Metadata = {
    title: "Trezu - Treasury Dashboard",
    description: "Manage your treasury with cross-chain multisig security",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html
            lang="en"
            suppressHydrationWarning
            className={`${geistSans.variable} ${geistMono.variable}`}
        >
            <head>
                <script
                    dangerouslySetInnerHTML={{
                        __html: `
              (function() {
                try {
                  const theme = localStorage.getItem('theme-storage');
                  if (theme) {
                    const parsedTheme = JSON.parse(theme);
                    if (parsedTheme.state?.theme === 'dark') {
                      document.documentElement.classList.add('dark');
                    }
                  }
                } catch (e) {}
              })();
            `,
                    }}
                />
            </head>
            <body
                className={`${geistSans.variable} ${geistMono.variable} antialiased`}
            >
                <QueryProvider>
                    <NearInitializer />
                    <AuthProvider>
                        <TourProvider>{children}</TourProvider>
                    </AuthProvider>
                    <Toaster />
                </QueryProvider>
            </body>
        </html>
    );
}

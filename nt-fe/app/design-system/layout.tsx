import type { Metadata } from "next";
import { Figtree, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { getLocaleDirection } from "@/i18n/config";
import "../globals.css";
import { QueryProvider } from "@/components/query-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/toaster";
import { WarningsProvider } from "@/hooks/use-warnings";

const figtree = Figtree({
    variable: "--font-figtree",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export const metadata: Metadata = {
    title: "Design System | Trezu",
    description: "Internal UI component, color, and typography audit page.",
};

export default async function DesignSystemLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const locale = await getLocale();
    const messages = await getMessages();
    const dir = getLocaleDirection(locale);

    return (
        <html
            lang={locale}
            dir={dir}
            suppressHydrationWarning
            className={`${figtree.variable} ${geistMono.variable}`}
        >
            <body
                className={`${figtree.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
            >
                <NextIntlClientProvider locale={locale} messages={messages}>
                    <QueryProvider>
                        <ThemeProvider>
                            <WarningsProvider>{children}</WarningsProvider>
                            <Toaster />
                        </ThemeProvider>
                    </QueryProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}

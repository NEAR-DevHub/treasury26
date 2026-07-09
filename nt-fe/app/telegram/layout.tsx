import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { getLocaleDirection } from "@/i18n/config";
import "../globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { NearInitializer } from "@/components/near-initializer";
import { QueryProvider } from "@/components/query-provider";
import { Toaster } from "@/components/toaster";
import { WarningsProvider } from "@/components/warnings-provider";

const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("pages.telegram");
    return {
        title: t("metaTitle"),
        description: t("metaDescription"),
    };
}

export default async function TelegramLayout({
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
            className={`${geistSans.variable} ${geistMono.variable}`}
        >
            <head>
                <link
                    rel="icon"
                    href="/favicon_light.svg"
                    type="image/svg+xml"
                    media="(prefers-color-scheme: light)"
                />
                <link
                    rel="icon"
                    href="/favicon_dark.svg"
                    type="image/svg+xml"
                    media="(prefers-color-scheme: dark)"
                />
            </head>
            <body
                className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
            >
                <NextIntlClientProvider locale={locale} messages={messages}>
                    <QueryProvider>
                        <WarningsProvider>
                            <NearInitializer />
                            <AuthProvider>{children}</AuthProvider>
                            <Toaster />
                        </WarningsProvider>
                    </QueryProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}

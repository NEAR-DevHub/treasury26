import type { Metadata } from "next";
import { Figtree, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { getLocaleDirection } from "@/i18n/config";
import "../globals.css";
import { QueryProvider } from "@/components/query-provider";

const figtree = Figtree({
    variable: "--font-figtree",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("pages.wallet");
    return {
        title: t("title"),
        description: t("description"),
    };
}

export default async function WalletLayout({
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
                className={`${figtree.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
            >
                <NextIntlClientProvider locale={locale} messages={messages}>
                    <QueryProvider>{children}</QueryProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}

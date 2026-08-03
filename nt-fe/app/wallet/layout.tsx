import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { getLocaleDirection } from "@/i18n/config";
import "../globals.css";
import { QueryProvider } from "@/components/query-provider";
import { figtree } from "@/lib/fonts";

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
            className={figtree.variable}
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
                className={`${figtree.variable} antialiased bg-background text-foreground`}
            >
                <NextIntlClientProvider locale={locale} messages={messages}>
                    <QueryProvider>{children}</QueryProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}

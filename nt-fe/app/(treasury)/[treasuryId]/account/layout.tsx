import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("pages.account");
    return { title: t("title") };
}

export default function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return children;
}

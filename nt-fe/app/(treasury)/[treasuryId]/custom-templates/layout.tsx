import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("customTemplates");
    return { title: t("pageTitle") };
}

export default function CustomTemplatesLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return children;
}

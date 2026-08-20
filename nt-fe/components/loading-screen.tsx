"use client";
import { Icon } from "@/components/icon";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";

export function LoadingScreen() {
    const t = useTranslations("common");

    return (
        <div className="flex min-h-screen items-center justify-center bg-page-bg text-foreground">
            <div className="flex flex-col items-center gap-4">
                <Icon
                    icon={Loading02Icon}
                    className="size-8 animate-spin text-muted-foreground"
                />
                <p className="text-sm text-muted-foreground">{t("loading")}</p>
            </div>
        </div>
    );
}

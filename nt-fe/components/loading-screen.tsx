"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

export function LoadingScreen() {
    const t = useTranslations("common");

    return (
        <div className="flex items-center justify-center min-h-screen">
            <div className="flex flex-col items-center gap-4">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t("loading")}</p>
            </div>
        </div>
    );
}

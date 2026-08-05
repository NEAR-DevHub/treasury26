"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert";

export function DepositGuestBanner() {
    const t = useTranslations("depositModal.guestBanner");

    return (
        <Alert variant="info" className="mb-1">
            <Info className="h-4 w-4 shrink-0" />
            <div className="flex flex-col gap-0.5">
                <AlertTitle className="text-sm font-semibold leading-none">
                    {t("title")}
                </AlertTitle>
                <AlertDescription className="text-sm">
                    {t("description")}
                </AlertDescription>
            </div>
        </Alert>
    );
}

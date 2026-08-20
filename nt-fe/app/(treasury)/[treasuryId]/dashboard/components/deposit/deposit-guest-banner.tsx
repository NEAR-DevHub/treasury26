"use client";
import { Icon } from "@/components/icon";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert";

export function DepositGuestBanner() {
    const t = useTranslations("depositModal.guestBanner");

    return (
        <Alert variant="info" className="mb-1">
            <Icon icon={InformationCircleIcon} className="shrink-0" />
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

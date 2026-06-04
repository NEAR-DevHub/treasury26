"use client";

import { useTranslations } from "next-intl";
import { useSystemStatus } from "@/hooks/use-system-status";
import { WarningAlert } from "@/components/warning-alert";
import { cn } from "@/lib/utils";

interface SystemStatusBannerProps {
    className?: string;
    isSidebar?: boolean;
}

export function SystemStatusBanner({
    className,
    isSidebar,
}: SystemStatusBannerProps) {
    const t = useTranslations("systemStatus");
    const { data: posts } = useSystemStatus();

    if (!posts?.length) return null;

    return (
        <div className={cn(className)}>
            <WarningAlert
                className={cn(isSidebar && "flex-col gap-2", className)}
                title={t("underMaintenance")}
                message={t("maintenanceMessage")}
            />
        </div>
    );
}

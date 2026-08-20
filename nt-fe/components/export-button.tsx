"use client";

import { Icon } from "@/components/icon";
import { FileDownloadIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/button";
import { useTreasury } from "@/hooks/use-treasury";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { trackEvent } from "@/lib/analytics";
import { useMediaQuery } from "@/hooks/use-media-query";

export function ExportButton() {
    const tCommon = useTranslations("common");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const isMobile = useMediaQuery("(max-width: 640px)");

    const handleClick = () => {
        trackEvent("export-click", {
            source: "export_button",
            treasury_id: treasuryId,
        });
        router.push(`/${treasuryId}/dashboard/export`);
    };

    return (
        <Button
            variant="secondary"
            onClick={handleClick}
            className="h-9 px-3"
            size={isMobile ? "icon" : "default"}
        >
            <Icon icon={FileDownloadIcon} />
            <span className="hidden sm:inline">{tCommon("export")}</span>
        </Button>
    );
}

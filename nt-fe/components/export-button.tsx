"use client";

import { Button } from "@/components/button";
import { useTreasury } from "@/hooks/use-treasury";
import { useRouter } from "next/navigation";
import { FileDown } from "lucide-react";
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
            <FileDown className="h-4 w-4" />
            <span className="hidden sm:inline">{tCommon("export")}</span>
        </Button>
    );
}

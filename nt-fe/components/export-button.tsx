"use client";

import { FileDownIcon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";

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
            className="md:h-10 md:gap-2 md:rounded-xl md:px-4"
            size={isMobile ? "icon" : "default"}
        >
            <Icon icon={FileDownIcon} />
            <span className="hidden sm:inline">{tCommon("export")}</span>
        </Button>
    );
}

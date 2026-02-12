"use client";

import { Button } from "@/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

export function MemberOnlyExportButton() {
    const { treasuryId, isGuestTreasury, isLoading } = useTreasury();
    const { accountId } = useNear();
    const router = useRouter();

    const isMember = !isGuestTreasury;

    const handleClick = () => {
        if (isMember && treasuryId) {
            router.push(`/${treasuryId}/dashboard/export`);
        }
    };

    const isDisabled = !isMember || isLoading;

    const button = (
        <Button
            variant="outline"
            onClick={handleClick}
            disabled={isDisabled}
            className="h-9 px-3"
        >
            <Upload className="h-4 w-4" />
            Export
        </Button>
    );

    // Show tooltip only if not a member and not loading
    if (!isMember && !isLoading && accountId) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-block">
                        {button}
                    </span>
                </TooltipTrigger>
                <TooltipContent>
                    <p>Only treasury members can export data</p>
                </TooltipContent>
            </Tooltip>
        );
    }

    return button;
}


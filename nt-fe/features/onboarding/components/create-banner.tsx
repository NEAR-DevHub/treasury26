"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Button } from "@/components/button";
import Logo from "@/components/logo";
import { useUserTreasuries } from "@/hooks/use-treasury-queries";
import { useNear } from "@/stores/near-store";

const CREATE_BANNER_DISMISSED_KEY = "create-banner-dismissed";

export function CreateBanner() {
    const router = useRouter();
    const { accountId } = useNear();
    const { data: treasuries = [], isLoading } = useUserTreasuries(accountId);
    const [isDismissed, setIsDismissed] = useState(true);

    useEffect(() => {
        setIsDismissed(
            localStorage.getItem(CREATE_BANNER_DISMISSED_KEY) === "true",
        );
    }, []);

    const hasMemberTreasury = treasuries.some((t) => t.isMember);

    if (isDismissed || isLoading || hasMemberTreasury || !accountId) {
        return null;
    }

    const handleDismiss = () => {
        localStorage.setItem(CREATE_BANNER_DISMISSED_KEY, "true");
        setIsDismissed(true);
    };

    return (
        <div className="bg-secondary rounded-lg p-3 flex flex-col gap-3 mx-3.5">
            <div className="flex items-center justify-between pb-1">
                <Logo size="sm" variant="icon" />
                <button
                    onClick={handleDismiss}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Close"
                >
                    <X className="size-3.5" />
                </button>
            </div>
            <div className="flex flex-col gap-1 text-foreground">
                <p className="text-sm font-medium">Explore Trezu</p>
                <p className="text-xs">
                    Create an account to unlock permissions to all features and
                    benefits of Trezu.
                </p>
            </div>
            <Button
                variant="secondary"
                className="w-full bg-card text-card-foreground hover:bg-card/80"
                onClick={() => router.push("/app/new")}
            >
                Create Treasury
            </Button>
        </div>
    );
}

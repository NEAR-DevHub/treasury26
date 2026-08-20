"use client";
import { Icon } from "@/components/icon";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useEffect } from "react";
import { Button } from "@/components/button";
import Logo from "@/components/icons/logo";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";

const CREATE_BANNER_DISMISSED_KEY = "create-banner-dismissed";
export function CreateBanner({ disabled = false }: { disabled?: boolean }) {
    const t = useTranslations("onboarding.createBanner");
    const router = useRouter();
    const pathname = usePathname();
    const { accountId } = useNear();
    const [isDismissed, setIsDismissed] = useState(true);
    const { isGuestTreasury, isLoading, treasuries } = useTreasury();

    useEffect(() => {
        setIsDismissed(
            localStorage.getItem(CREATE_BANNER_DISMISSED_KEY) === "true",
        );
    }, []);

    if (
        isDismissed ||
        isLoading ||
        !accountId ||
        !isGuestTreasury ||
        disabled
    ) {
        return null;
    }

    const handleDismiss = () => {
        localStorage.setItem(CREATE_BANNER_DISMISSED_KEY, "true");
        setIsDismissed(true);
    };
    const createTreasuryRoute = `/create?returnTo=${encodeURIComponent(pathname || "/")}`;

    return (
        <div className="flex flex-col gap-3 rounded-2xl bg-general-tertiary p-3.5 sm:mx-3 sm:bg-secondary">
            <div className="flex items-center justify-between pb-1">
                <Logo size="sm" variant="icon" />
                <button
                    type="button"
                    onClick={handleDismiss}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={t("close")}
                >
                    <Icon icon={Cancel01Icon} />
                </button>
            </div>
            <div className="flex flex-col gap-1 text-foreground">
                <p className="text-sm font-medium">{t("title")}</p>
                <p className="text-xs">{t("description")}</p>
            </div>
            <Button
                variant="secondary"
                size="sm"
                className="w-full bg-card text-card-foreground hover:bg-card/80"
                onClick={() => router.push(createTreasuryRoute)}
            >
                {t("cta")}
            </Button>
        </div>
    );
}

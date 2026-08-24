"use client";

import {
    DashboardSquare01Icon,
    Home04Icon,
    InboxIcon,
    UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useMobileShellStore } from "@/stores/mobile-shell-store";

export function MobileBottomNav() {
    const t = useTranslations("nav");
    const pathname = usePathname();
    const router = useRouter();
    const { treasuryId } = useTreasury();
    const sheet = useMobileShellStore((state) => state.sheet);
    const openSheet = useMobileShellStore((state) => state.openSheet);
    const closeSheet = useMobileShellStore((state) => state.closeSheet);

    const items = [
        {
            id: "dashboard",
            href: `/${treasuryId}`,
            label: t("dashboard"),
            icon: Home04Icon,
            isActive:
                pathname === `/${treasuryId}` ||
                pathname === `/${treasuryId}/` ||
                (pathname?.startsWith(`/${treasuryId}/dashboard`) ?? false),
        },
        {
            id: "requests",
            href: `/${treasuryId}/requests`,
            label: t("requests"),
            icon: InboxIcon,
            isActive: pathname?.startsWith(`/${treasuryId}/requests`) ?? false,
        },
        {
            id: "contacts",
            href: `/${treasuryId}/address-book`,
            label: t("addressBook"),
            icon: UserAccountIcon,
            isActive:
                pathname?.startsWith(`/${treasuryId}/address-book`) ?? false,
        },
    ] as const;

    const isMenuRoute =
        pathname?.startsWith(`/${treasuryId}/payments`) === true ||
        pathname?.startsWith(`/${treasuryId}/exchange`) === true ||
        pathname?.startsWith(`/${treasuryId}/members`) === true ||
        pathname?.startsWith(`/${treasuryId}/settings`) === true;
    const isMenuActive = sheet === "menu" || isMenuRoute;

    return (
        <nav
            className="lg:hidden sticky bottom-0 z-30 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-white/10 dark:bg-gray-900"
            data-testid="mobile-bottom-nav"
        >
            <div className="grid grid-cols-4">
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                            closeSheet();
                            trackEvent("nav-click", {
                                destination: item.id,
                                source: "mobile-bottom-nav",
                                treasury_id: treasuryId,
                            });
                            router.push(item.href);
                        }}
                        className={cn(
                            "flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-medium",
                            item.isActive
                                ? "text-foreground"
                                : "text-muted-foreground",
                        )}
                    >
                        <Icon icon={item.icon} className="size-5" />
                        {item.label}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => openSheet("menu")}
                    className={cn(
                        "flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-medium",
                        isMenuActive
                            ? "text-foreground"
                            : "text-muted-foreground",
                    )}
                    data-testid="mobile-nav-menu"
                >
                    <Icon icon={DashboardSquare01Icon} className="size-5" />
                    {t("menu")}
                </button>
            </div>
        </nav>
    );
}

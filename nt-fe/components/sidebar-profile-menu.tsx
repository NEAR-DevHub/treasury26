"use client";

import { Icon } from "@/components/icon";
import {
    ArrowUp01Icon,
    MessageQuestionIcon,
    MoonIcon,
    Sun01Icon,
    UserIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
    AccountMenuItems,
    accountMenuItemClass,
    ConnectWalletButton,
} from "@/components/sign-in";
import { Tooltip } from "@/components/tooltip";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { isStaging } from "@/constants/features";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

interface SidebarProfileMenuProps {
    /** Collapsed rail — the trigger reduces to the avatar chip alone. */
    isReduced: boolean;
    onOpenSupport: () => void;
}

export function SidebarProfileMenu({
    isReduced,
    onOpenSupport,
}: SidebarProfileMenuProps) {
    const tNav = useTranslations("nav");
    const tHeader = useTranslations("header");
    const { accountId, isAuthenticated } = useNear();
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    // On touch, `Tooltip` falls back to a popover of its own, which would fire
    // alongside this menu on tap — and the menu already spells out the account.
    const isTouchDevice = useMediaQuery("(hover: none)");

    useEffect(() => {
        setMounted(true);
    }, []);

    const isDarkTheme = mounted ? resolvedTheme === "dark" : true;

    if (!accountId || !isAuthenticated) {
        return (
            <ConnectWalletButton
                className={cn("w-full", isReduced && "size-11 px-0")}
            />
        );
    }

    const avatar = (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-green-500">
            <Icon icon={UserIcon} className="text-gray-900" />
        </span>
    );

    const trigger = isReduced ? (
        <button
            type="button"
            id="help-support-link"
            aria-label={accountId}
            className={cn(
                "mx-auto flex size-11 cursor-pointer items-center justify-center rounded-2xl border border-transparent bg-gray-900 transition-colors duration-200 hover:bg-gray-950",
                isOpen && "bg-gray-950",
            )}
        >
            {avatar}
        </button>
    ) : (
        <button
            type="button"
            id="help-support-link"
            className={cn(
                "group flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-transparent bg-gray-900 p-3.5 transition-colors duration-200 hover:bg-gray-950",
                isOpen && "bg-gray-950",
            )}
        >
            {avatar}
            <span className="min-w-0 flex-1 truncate text-start font-semibold text-sm text-gray-900 dark:text-white">
                {accountId}
            </span>
            {isStaging && (
                // Decorative — the menu itself carries a labelled "Staging" row.
                <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-general-orange-foreground"
                />
            )}
            <Icon
                icon={ArrowUp01Icon}
                className={cn(
                    "shrink-0 text-gray-500 transition-transform duration-150 group-hover:text-gray-900 dark:text-gray-400 dark:group-hover:text-white",
                    isOpen && "rotate-180",
                )}
            />
        </button>
    );

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen} modal={false}>
            {isReduced ? (
                <Tooltip
                    content={accountId}
                    side="right"
                    disabled={isTouchDevice}
                >
                    <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                </Tooltip>
            ) : (
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            )}
            {/* Portalled out of the rail, so `dark` is re-declared here to keep the
                menu in step with the always-dark rail it drops out of. */}
            <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="dark w-66 rounded-2xl border-white/10 bg-gray-950 p-1.5 text-white shadow-xl"
            >
                <AccountMenuItems
                    accountId={accountId}
                    onNavigate={() => setIsOpen(false)}
                />
                <div className="-mx-1.5 mt-1 flex flex-col border-t border-border px-1.5 pt-1 dark:border-general-border">
                    <LanguageSwitcher asMenuRow align="start" />
                    <button
                        type="button"
                        className={accountMenuItemClass}
                        onClick={() => setTheme(isDarkTheme ? "light" : "dark")}
                    >
                        {isDarkTheme ? (
                            <Icon icon={Sun01Icon} />
                        ) : (
                            <Icon icon={MoonIcon} />
                        )}
                        {tHeader("toggleTheme")}
                    </button>
                    <button
                        type="button"
                        className={accountMenuItemClass}
                        onClick={() => {
                            setIsOpen(false);
                            onOpenSupport();
                        }}
                    >
                        <Icon icon={MessageQuestionIcon} />
                        {tNav("helpSupport")}
                    </button>
                    {isStaging && (
                        <span className="flex items-center gap-2 px-3 py-2 text-general-orange-foreground text-xs font-medium">
                            <span className="size-1.5 rounded-full bg-general-orange-foreground" />
                            Staging
                        </span>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

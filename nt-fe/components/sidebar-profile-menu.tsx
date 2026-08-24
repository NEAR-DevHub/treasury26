"use client";

import { Icon } from "@/components/icon";
import {
    ArrowUp01Icon,
    CircleQuestionMarkIcon,
    File01Icon,
    LogoutSquare01Icon,
    Moon02Icon,
    User03Icon,
    UserIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
    accountMenuItemClass,
    ConnectWalletButton,
} from "@/components/sign-in";
import { Tooltip } from "@/components/tooltip";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/constants/config";
import { isStaging } from "@/constants/features";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useProfile } from "@/hooks/use-treasury-queries";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

interface SidebarProfileMenuProps {
    /** Collapsed rail — the trigger reduces to the avatar chip alone. */
    isReduced: boolean;
    onOpenSupport: () => void;
}

function MenuDivider() {
    return (
        <div aria-hidden="true" className="-mx-1.5 my-2 h-px bg-[#262626]" />
    );
}

export function SidebarProfileMenu({
    isReduced,
    onOpenSupport,
}: SidebarProfileMenuProps) {
    const t = useTranslations("signIn");
    const tNav = useTranslations("nav");
    const tHeader = useTranslations("header");
    const tAddress = useTranslations("address");
    const { accountId, isAuthenticated, disconnect } = useNear();
    const { treasuryId } = useTreasury();
    const { data: profile } = useProfile(accountId);
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
    const displayName =
        profile?.name && profile.name !== accountId ? profile.name : accountId;
    const accountHref = treasuryId ? `/${treasuryId}/account` : null;

    const close = () => setIsOpen(false);

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
                <div className="flex items-center justify-between gap-3 px-3 py-1">
                    <div className="min-w-0 px-3">
                        <p className="truncate font-semibold text-sm">
                            {displayName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                            {accountId}
                        </p>
                    </div>
                    <CopyButton
                        text={accountId}
                        toastMessage={tAddress("copied")}
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
                        iconClassName="size-4"
                    />
                </div>
                <MenuDivider />
                <div className="flex flex-col">
                    {accountHref ? (
                        <Link
                            href={accountHref}
                            className={accountMenuItemClass}
                            onClick={close}
                        >
                            <Icon icon={User03Icon} />
                            {t("myAccount")}
                        </Link>
                    ) : null}
                    <button
                        type="button"
                        className={accountMenuItemClass}
                        onClick={() => setTheme(isDarkTheme ? "light" : "dark")}
                    >
                        <Icon icon={Moon02Icon} />
                        {tHeader("darkMode")}
                    </button>
                    <LanguageSwitcher asMenuRow align="start" />
                </div>
                <MenuDivider />
                <div className="flex flex-col">
                    <button
                        type="button"
                        className={accountMenuItemClass}
                        onClick={() => {
                            close();
                            onOpenSupport();
                        }}
                    >
                        <Icon icon={CircleQuestionMarkIcon} />
                        {tNav("helpSupport")}
                    </button>
                    <Link
                        href={TERMS_OF_SERVICE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={accountMenuItemClass}
                        onClick={close}
                    >
                        <Icon icon={File01Icon} />
                        {t("termsOfService")}
                    </Link>
                    <Link
                        href={PRIVACY_POLICY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={accountMenuItemClass}
                        onClick={close}
                    >
                        <Icon icon={File01Icon} />
                        {t("privacyPolicy")}
                    </Link>
                </div>
                <MenuDivider />
                <div>
                    <button
                        type="button"
                        className={accountMenuItemClass}
                        onClick={() => {
                            disconnect();
                            close();
                        }}
                    >
                        <Icon icon={LogoutSquare01Icon} />
                        {t("signOut")}
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

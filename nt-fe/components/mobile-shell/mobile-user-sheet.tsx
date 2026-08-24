"use client";

import {
    CircleQuestionMarkIcon,
    File01Icon,
    Globe02Icon,
    LogoutSquare01Icon,
    Moon02Icon,
    User03Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icon";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/modal";
import { SupportCenterModal } from "@/components/support-center-modal";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/constants/config";
import { useTreasury } from "@/hooks/use-treasury";
import { useProfile } from "@/hooks/use-treasury-queries";
import { isEnabledLocale, localeFlags, type Locale } from "@/i18n/config";
import { useMobileShellStore } from "@/stores/mobile-shell-store";
import { useNear } from "@/stores/near-store";

const rowClass =
    "flex w-full items-center gap-3 py-3 text-left text-[15px] font-medium text-muted-foreground";
function MenuDivider() {
    return (
        <div
            aria-hidden="true"
            className="-mx-4 my-2 h-px bg-general-border dark:bg-[#262626]"
        />
    );
}

export function MobileUserSheet() {
    const t = useTranslations("signIn");
    const tNav = useTranslations("nav");
    const tHeader = useTranslations("header");
    const tLang = useTranslations("languageSwitcher");
    const tAddress = useTranslations("address");
    const locale = useLocale() as Locale;
    const { accountId, disconnect, isAuthenticated } = useNear();
    const { treasuryId } = useTreasury();
    const { data: profile } = useProfile(accountId);
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const [supportOpen, setSupportOpen] = useState(false);
    const sheet = useMobileShellStore((state) => state.sheet);
    const openSheet = useMobileShellStore((state) => state.openSheet);
    const closeSheet = useMobileShellStore((state) => state.closeSheet);

    useEffect(() => {
        setMounted(true);
    }, []);

    const isDarkTheme = mounted ? resolvedTheme === "dark" : true;
    const displayName =
        profile?.name && profile.name !== accountId ? profile.name : accountId;

    if (!accountId || !isAuthenticated) return null;

    return (
        <>
            <Dialog
                open={sheet === "user"}
                onOpenChange={(open) => {
                    if (!open) closeSheet();
                }}
            >
                <DialogContent>
                    <SheetHandle />
                    <DialogTitle className="sr-only">
                        {t("myAccount")}
                    </DialogTitle>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="truncate font-semibold text-foreground">
                                {displayName}
                            </p>
                            <p className="truncate text-sm text-muted-foreground">
                                {accountId}
                            </p>
                        </div>
                        <CopyButton
                            text={accountId}
                            toastMessage={tAddress("copied")}
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-muted-foreground"
                            iconClassName="size-5"
                        />
                    </div>
                    <MenuDivider />
                    <div className="flex flex-col">
                        {treasuryId ? (
                            <Link
                                href={`/${treasuryId}/account`}
                                className={rowClass}
                                onClick={closeSheet}
                            >
                                <Icon icon={User03Icon} className="size-5" />
                                {t("myAccount")}
                            </Link>
                        ) : null}
                        <button
                            type="button"
                            className={rowClass}
                            onClick={() =>
                                setTheme(isDarkTheme ? "light" : "dark")
                            }
                        >
                            <Icon icon={Moon02Icon} className="size-5" />
                            {tHeader("darkMode")}
                        </button>
                        <button
                            type="button"
                            className={rowClass}
                            onClick={() => openSheet("language")}
                        >
                            <Icon icon={Globe02Icon} className="size-5" />
                            <span className="flex-1">{tLang("label")}</span>
                            <span aria-hidden="true">
                                {
                                    localeFlags[
                                        isEnabledLocale(locale) ? locale : "en"
                                    ]
                                }
                            </span>
                        </button>
                    </div>
                    <MenuDivider />
                    <div className="flex flex-col">
                        <button
                            type="button"
                            className={rowClass}
                            onClick={() => {
                                closeSheet();
                                setSupportOpen(true);
                            }}
                        >
                            <Icon
                                icon={CircleQuestionMarkIcon}
                                className="size-5"
                            />
                            {tNav("helpSupport")}
                        </button>
                        <Link
                            href={TERMS_OF_SERVICE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={rowClass}
                            onClick={closeSheet}
                        >
                            <Icon icon={File01Icon} className="size-5" />
                            {t("termsOfService")}
                        </Link>
                        <Link
                            href={PRIVACY_POLICY_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={rowClass}
                            onClick={closeSheet}
                        >
                            <Icon icon={File01Icon} className="size-5" />
                            {t("privacyPolicy")}
                        </Link>
                    </div>
                    <MenuDivider />
                    <div>
                        <button
                            type="button"
                            className={rowClass}
                            onClick={() => {
                                disconnect();
                                closeSheet();
                            }}
                        >
                            <Icon
                                icon={LogoutSquare01Icon}
                                className="size-5"
                            />
                            {t("signOut")}
                        </button>
                    </div>
                </DialogContent>
            </Dialog>
            <SupportCenterModal
                open={supportOpen}
                onOpenChange={setSupportOpen}
            />
        </>
    );
}

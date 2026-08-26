"use client";
import { Icon } from "@/components/icon";
import { Globe02Icon, CheckIcon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/button";
import { accountMenuItemClass } from "@/components/sign-in";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    enabledLocales,
    localeFlags,
    localeNames,
    LOCALE_COOKIE,
    type Locale,
} from "@/i18n/config";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
    align?: "start" | "end" | "center";
    className?: string;
    variant?: "ghost" | "outline";
    /** Render as a full-width labelled row, for use inside another menu. */
    asMenuRow?: boolean;
}

export function LanguageSwitcher({
    align = "end",
    className,
    variant = "ghost",
    asMenuRow = false,
}: LanguageSwitcherProps) {
    const locale = useLocale() as Locale;
    const t = useTranslations("languageSwitcher");
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const handleSelect = (next: Locale) => {
        if (next === locale) return;
        const maxAge = 60 * 60 * 24 * 365;
        const isSecure =
            typeof window !== "undefined" &&
            window.location.protocol === "https:";
        const secureAttr = isSecure ? "; Secure" : "";
        // biome-ignore lint/suspicious/noDocumentCookie: locale cookie is read synchronously by the Next.js request config on the next navigation, so a client-side cookie write is the simplest path
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${maxAge}; samesite=lax${secureAttr}`;
        startTransition(() => {
            router.refresh();
        });
    };

    return (
        <DropdownMenu modal={!asMenuRow}>
            <DropdownMenuTrigger asChild>
                {asMenuRow ? (
                    <Button
                        variant="ghost"
                        aria-label={t("select")}
                        disabled={isPending}
                        className={cn(
                            accountMenuItemClass,
                            "h-auto justify-start",
                            className,
                        )}
                    >
                        <Icon icon={Globe02Icon} />
                        <span className="flex-1 text-start">{t("label")}</span>
                        <span aria-hidden="true">{localeFlags[locale]}</span>
                    </Button>
                ) : (
                    <Button
                        variant={variant}
                        size="icon-sm"
                        aria-label={t("select")}
                        disabled={isPending}
                        className={cn(
                            "text-muted-foreground hover:bg-muted hover:text-foreground",
                            className,
                        )}
                    >
                        <Icon icon={Globe02Icon} />
                    </Button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align={align}
                side={asMenuRow ? "right" : "bottom"}
                sideOffset={asMenuRow ? 8 : 4}
                className={cn(
                    "min-w-[160px]",
                    asMenuRow &&
                        "dark rounded-2xl border-white/10 bg-gray-950 p-1.5 text-white shadow-xl",
                )}
            >
                {enabledLocales.map((code) => (
                    <DropdownMenuItem
                        key={code}
                        onSelect={() => handleSelect(code)}
                        className={cn(
                            "flex items-center justify-between gap-2",
                            asMenuRow && "rounded-md px-3 py-2",
                        )}
                    >
                        <span className="flex items-center gap-2">
                            <span aria-hidden="true" className="text-base">
                                {localeFlags[code]}
                            </span>
                            <span>{localeNames[code]}</span>
                        </span>
                        {code === locale && <Icon icon={CheckIcon} />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

"use client";

import { Check, Globe } from "lucide-react";
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
import { enabledLocales, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

const labelKeyByLocale: Record<Locale, string> = {
    en: "english",
    es: "spanish",
    uk: "ukrainian",
    he: "hebrew",
    de: "german",
    fr: "french",
    vi: "vietnamese",
    zh: "chinese",
    tr: "turkish",
    id: "indonesian",
    pt: "portuguese",
    ja: "japanese",
    ko: "korean",
};

const flagByLocale: Record<Locale, string> = {
    en: "🇬🇧",
    es: "🇪🇸",
    uk: "🇺🇦",
    he: "🇮🇱",
    de: "🇩🇪",
    fr: "🇫🇷",
    vi: "🇻🇳",
    zh: "🇨🇳",
    tr: "🇹🇷",
    id: "🇮🇩",
    pt: "🇧🇷",
    ja: "🇯🇵",
    ko: "🇰🇷",
};

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
        <DropdownMenu>
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
                        <Globe className="size-4" />
                        <span className="flex-1 text-start">{t("select")}</span>
                        <span aria-hidden="true">{flagByLocale[locale]}</span>
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
                        <Globe className="size-5" />
                    </Button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align={align}
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
                                {flagByLocale[code]}
                            </span>
                            <span>{t(labelKeyByLocale[code])}</span>
                        </span>
                        {code === locale && <Check className="h-4 w-4" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

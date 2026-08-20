"use client";

import { Tick01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { enabledLocales, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { useMobileShellStore } from "@/stores/mobile-shell-store";

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

export function MobileLanguageSheet() {
    const t = useTranslations("languageSwitcher");
    const locale = useLocale() as Locale;
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const sheet = useMobileShellStore((state) => state.sheet);
    const closeSheet = useMobileShellStore((state) => state.closeSheet);

    const handleSelect = (next: Locale) => {
        if (next === locale) return;
        const maxAge = 60 * 60 * 24 * 365;
        const isSecure =
            typeof window !== "undefined" &&
            window.location.protocol === "https:";
        const secureAttr = isSecure ? "; Secure" : "";
        // biome-ignore lint/suspicious/noDocumentCookie: locale cookie is read synchronously by Next.js
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${maxAge}; samesite=lax${secureAttr}`;
        startTransition(() => {
            router.refresh();
        });
    };

    return (
        <Dialog
            open={sheet === "language"}
            onOpenChange={(open) => {
                if (!open) closeSheet();
            }}
        >
            <DialogContent className="overflow-hidden">
                <SheetHandle />
                <DialogHeader className="mx-0 border-b-0 px-0 py-0">
                    <DialogTitle className="text-left">
                        {t("label")}
                    </DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
                    {enabledLocales.map((code) => (
                        <button
                            key={code}
                            type="button"
                            disabled={isPending}
                            onClick={() => handleSelect(code)}
                            className="flex w-full items-center gap-3 rounded-xl py-3 text-left text-[15px] font-medium"
                        >
                            <span aria-hidden="true" className="text-base">
                                {flagByLocale[code]}
                            </span>
                            <span className="flex-1">
                                {t(labelKeyByLocale[code])}
                            </span>
                            {code === locale ? (
                                <Icon
                                    icon={Tick01Icon}
                                    className="size-4 text-foreground"
                                />
                            ) : null}
                        </button>
                    ))}
                </div>
                <div className="shrink-0 pt-3">
                    <Button
                        className="h-12 w-full rounded-full"
                        onClick={closeSheet}
                    >
                        {t("done")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

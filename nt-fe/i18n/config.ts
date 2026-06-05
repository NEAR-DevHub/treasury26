import { features } from "@/constants/features";

export const locales = [
    "en",
    "es",
    "uk",
    "he",
    "de",
    "fr",
    "vi",
    "zh",
    "tr",
    "id",
    "pt",
    "ja",
    "ko",
] as const;
export type Locale = (typeof locales)[number];

/** Locales always exposed to end users in production. */
const corePublicLocales: readonly Locale[] = ["en", "es", "pt", "uk"];

/**
 * Locales that are visible to end users at runtime.
 *
 * In production this is gated to en/es/uk via features.extraLocales;
 * staging and development show every locale we ship messages for so QA
 * and translators can preview them.
 */
export const enabledLocales: readonly Locale[] = features.extraLocales
    ? locales
    : corePublicLocales;

export function isEnabledLocale(
    value: string | undefined | null,
): value is Locale {
    return !!value && enabledLocales.includes(value as Locale);
}

export const defaultLocale: Locale = "en";

export const localeNames: Record<Locale, string> = {
    en: "English",
    es: "Español",
    uk: "Українська",
    he: "עברית",
    de: "Deutsch",
    fr: "Français",
    vi: "Tiếng Việt",
    zh: "中文",
    tr: "Türkçe",
    id: "Bahasa Indonesia",
    pt: "Português",
    ja: "日本語",
    ko: "한국어",
};

/** Right-to-left locales. */
export const rtlLocales: readonly Locale[] = ["he"];

export function getLocaleDirection(
    locale: Locale | string | undefined | null,
): "ltr" | "rtl" {
    if (!isEnabledLocale(locale)) {
        return "ltr";
    }
    return rtlLocales.includes(locale) ? "rtl" : "ltr";
}

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function pickLocaleFromAcceptLanguage(header: string | null): Locale {
    if (!header) return defaultLocale;
    const parts = header
        .split(",")
        .map((part) => {
            const [tag, q] = part.trim().split(";q=");
            const parsedQ = q ? Number.parseFloat(q) : 1;
            const weight = Number.isFinite(parsedQ)
                ? Math.min(1, Math.max(0, parsedQ))
                : 0;
            return {
                tag: tag.toLowerCase(),
                q: weight,
            };
        })
        .sort((a, b) => b.q - a.q);

    for (const { tag } of parts) {
        const base = tag.split("-")[0];
        if (isEnabledLocale(base)) return base;
    }
    return defaultLocale;
}

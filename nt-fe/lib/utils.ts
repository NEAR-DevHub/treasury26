import Big from "@/lib/big";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { clsx, type ClassValue } from "clsx";
import { format } from "date-fns";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// Built-in btoa() JS function fails on UTF8 inputs.
// `Buffer` polyfill brings +30kb to the minified bundle.
// https://stackoverflow.com/questions/23223718/failed-to-execute-btoa-on-window-the-string-to-be-encoded-contains-characte
export function jsonToBase64(json: any): string {
    const uint8Array = new TextEncoder().encode(JSON.stringify(json));
    let binary = "";

    for (let i = 0; i < uint8Array.length; ++i) {
        binary += String.fromCharCode(uint8Array[i]);
    }

    return btoa(binary);
}

export function base64ToJson(base64: string): any {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return JSON.parse(decoded);
}

export function formatCurrency(value: number | Big) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
    }).format(typeof value === "number" ? value : Number(value.toString()));
}

/**
 * Format token amount with optimal precision based on USD value
 * Shows enough decimals to represent $0.01 equivalent accurately (truncated, never rounded up)
 *
 * @param bigIntAmount - Token amount in smallest unit as string (e.g., "30517641175187890330" for 30.517 ETH with 18 decimals)
 * @param tokenDecimals - Number of decimals for the token (e.g., 18 for ETH, 8 for BTC)
 * @param tokenPrice - USD price per token (e.g., 60000 for BTC)
 * @returns Formatted string with thousand separators and optimal decimals
 *
 * @example
 * // BTC @ $60,000:
 * formatTokenAmount("50000000", 8, 60000)    // "0.5" ($30,000)
 * formatTokenAmount("250000", 8, 60000)      // "0.0025" ($150)
 * formatTokenAmount("3333", 8, 60000)        // "0.00003333" ($2)
 *
 * // ETH @ $3,000:
 * formatTokenAmount("10000000000000000000", 18, 3000)  // "10" ($30,000)
 * formatTokenAmount("50000000000000000", 18, 3000)     // "0.05" ($150)
 */
export function formatTokenAmount(
    bigIntAmount: string,
    tokenDecimals: number,
    tokenPrice: number,
): string {
    // Step 1: Convert to Big decimal number
    const divisor = Big(10).pow(tokenDecimals);
    const tokenAmount = Big(bigIntAmount).div(divisor);

    // Step 2: Determine decimals needed to represent $0.01 equivalent
    // We need: tokenAmount * price to be accurate within $0.01
    // Required token precision = $0.01 / tokenPrice
    const requiredTokenPrecision = Big(0.01).div(tokenPrice);

    // Step 3: Calculate decimals needed: ceil(-log10(requiredTokenPrecision))
    // Using: -log10(x) = -ln(x) / ln(10)
    const log10Value =
        Math.log(Number(requiredTokenPrecision.toString())) / Math.log(10);
    const decimalsNeeded = Math.max(0, Math.ceil(-log10Value));

    // Cap at token's native decimals (e.g., 18 for ETH, 8 for BTC)
    const finalDecimals = Math.min(decimalsNeeded, tokenDecimals);

    // Step 4: Format with calculated decimals (truncate, don't round up)
    // We must never show more tokens than the user will actually receive
    const multiplier = Big(10).pow(finalDecimals);
    const truncated = tokenAmount
        .mul(multiplier)
        .round(0, Big.roundDown)
        .div(multiplier);
    let formatted = truncated.toFixed(finalDecimals);

    // Remove trailing zeros
    formatted = formatted.replace(/\.?0+$/, "");

    // Add thousand separators
    const parts = formatted.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    formatted = parts.join(".");

    return formatted;
}

/**
 * Format a proposal status-based date with relative time.
 * - Future dates (pending/expiring): "in X minutes/hours/days/months"
 * - Past dates (executed/rejected/etc): "X minutes/hours/days/months ago"
 * - After 6 months threshold: absolute date "Mar 12, 2026"
 *
 * @param date - The relevant date for the status (expiration, execution, etc.)
 * @param isFuture - Whether the date is in the future (for pending expiry)
 * @returns Formatted string
 */
export interface RelativeTimeLabels {
    /** Fallback "moments" when diff < 1 minute; Intl handles the rest. */
    moments: string;
    /** Fallback "Just now" for past < 1 minute (formatRelativeTime only). */
    justNow: string;
    /** Locale BCP47 tag for Intl.RelativeTimeFormat + date-fns format fallback. */
    locale: string;
}

function formatAbsoluteDate(date: Date, locale: string): string {
    return date.toLocaleDateString(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function intlRelative(
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    locale: string,
): string {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        value,
        unit,
    );
}

export function formatProposalStatusDate(
    date: Date,
    isFuture: boolean,
    labels: RelativeTimeLabels,
): string {
    const now = new Date();
    const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

    const diffMs = isFuture
        ? date.getTime() - now.getTime()
        : now.getTime() - date.getTime();

    // If beyond 6 months, show absolute date
    if (diffMs > SIX_MONTHS_MS) {
        return formatAbsoluteDate(date, labels.locale);
    }

    const diffInSeconds = Math.floor(diffMs / 1000);
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);
    const diffInMonths = Math.floor(diffInDays / 30);

    const sign = isFuture ? 1 : -1;

    if (diffInMonths >= 1) {
        return intlRelative(sign * diffInMonths, "month", labels.locale);
    }
    if (diffInDays >= 1) {
        return intlRelative(sign * diffInDays, "day", labels.locale);
    }
    if (diffInHours >= 1) {
        return intlRelative(sign * diffInHours, "hour", labels.locale);
    }
    if (diffInMinutes >= 1) {
        return intlRelative(sign * diffInMinutes, "minute", labels.locale);
    }
    return labels.moments;
}

function normalizeDate(
    date: Date | string | number | null | undefined,
): Date | null {
    if (date == null || date === "") {
        return null;
    }

    const dateObj =
        typeof date === "string" || typeof date === "number"
            ? new Date(date)
            : date;

    return Number.isNaN(dateObj.getTime()) ? null : dateObj;
}

/**
 * Format a date as relative time (e.g., "2 minutes ago", "Yesterday")
 * After 1 week, returns static date format (e.g., "Feb 18, 2026")
 */
export function formatRelativeTime(
    date: Date | string | number | null | undefined,
    labels: RelativeTimeLabels,
): string {
    const dateObj = normalizeDate(date);
    if (!dateObj) {
        return "";
    }

    const now = new Date();
    const diffInSeconds = Math.floor(
        (now.getTime() - dateObj.getTime()) / 1000,
    );
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);

    // Just now (less than 1 minute)
    if (diffInSeconds < 60) {
        return labels.justNow;
    }

    // Minutes ago (1-59 minutes)
    if (diffInMinutes < 60) {
        return intlRelative(-diffInMinutes, "minute", labels.locale);
    }

    // Hours ago (1-23 hours)
    if (diffInHours < 24) {
        return intlRelative(-diffInHours, "hour", labels.locale);
    }

    // Days ago (1-6 days, "yesterday" handled by Intl numeric:"auto")
    if (diffInDays < 7) {
        return intlRelative(-diffInDays, "day", labels.locale);
    }

    // Week ago (exactly 7 days)
    if (diffInDays < 14) {
        return intlRelative(-1, "week", labels.locale);
    }

    // After 1 week: static date format
    return formatAbsoluteDate(dateObj, labels.locale);
}

export function formatTimestamp(date: Date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime() * 1000000;
}

/**
 * Format date according to user preferences (timezone and time format)
 * @param date - Date to format
 * @param options - Formatting options
 * @returns Formatted date string
 */
export interface FormatUserDateOptions {
    /** User's timezone (e.g., "America/New_York", "UTC") */
    timezone?: string | null;
    /** Time format: 12-hour or 24-hour */
    timeFormat?: "12" | "24";
    /** Whether to include time in the output */
    includeTime?: boolean;
    /** Whether to include timezone abbreviation */
    includeTimezone?: boolean;
    /** Custom date-fns format string (overrides other options) */
    customFormat?: string;
}

export function formatUserDate(
    date: Date | string | number | null | undefined,
    options: FormatUserDateOptions = {},
): string {
    const dateObj = normalizeDate(date);
    if (!dateObj) return "";

    const {
        timezone = null,
        timeFormat = "12",
        includeTime = true,
        includeTimezone = true,
        customFormat,
    } = options;

    // If custom format is provided, use date-fns format
    if (customFormat) {
        return format(dateObj, customFormat);
    }

    // Use Intl.DateTimeFormat for timezone-aware formatting
    try {
        const formatOptions: Intl.DateTimeFormatOptions = {
            month: "short",
            day: "numeric",
            year: "numeric",
            ...(timezone && { timeZone: timezone }),
        };

        // Add time formatting options if requested
        if (includeTime) {
            formatOptions.hour = "numeric";
            formatOptions.minute = "2-digit";
            formatOptions.hour12 = timeFormat === "12";
        }

        // Add timezone name if requested
        if (includeTimezone && includeTime) {
            formatOptions.timeZoneName = "short";
        }

        const formatter = new Intl.DateTimeFormat("en-US", formatOptions);
        return formatter.format(dateObj).replace("GMT", "UTC");
    } catch (error) {
        console.error("Error formatting date with Intl:", error);

        // Fallback to date-fns formatting
        let formatString = "MMM dd, yyyy";
        if (includeTime) {
            formatString += timeFormat === "12" ? " hh:mm a" : " HH:mm";
        }

        let formattedDate = format(dateObj, formatString);

        // Add timezone info as fallback
        if (includeTimezone) {
            const timezoneOffset = dateObj.getTimezoneOffset();
            const offsetHours = Math.abs(Math.floor(timezoneOffset / 60));
            const offsetMinutes = Math.abs(timezoneOffset % 60);

            let timezoneStr = "UTC";
            if (timezoneOffset !== 0) {
                const sign = timezoneOffset > 0 ? "-" : "+";
                timezoneStr = `UTC${sign}${offsetHours}${offsetMinutes > 0 ? `:${offsetMinutes.toString().padStart(2, "0")}` : ""}`;
            }
            formattedDate += ` ${timezoneStr}`;
        }

        // return formattedDate;
        return dateObj.toUTCString().replace("GMT", "UTC");
    }
}

export function formatGas(gas: string): string {
    return `${formatBalance(gas, 12, 2)}`;
}

/**
 * Convert a decimal token amount to raw/base units using token decimals.
 * Returns 0 for empty/invalid/non-positive inputs.
 */
export function toBaseUnits(
    amount: string | number | Big | null | undefined,
    decimals: number,
): Big {
    if (amount === null || amount === undefined) return Big(0);

    const normalized = amount.toString().trim();
    if (!normalized || isNaN(Number(normalized)) || Number(normalized) <= 0) {
        return Big(0);
    }

    return Big(normalized).mul(Big(10).pow(decimals));
}

export function formatBalance(
    balance: string | Big,
    decimals: number,
    displayDecimals: number = 5,
): string {
    // Handle null/undefined/empty values
    if (!balance || (typeof balance === "string" && balance.trim() === "")) {
        return "0";
    }

    let parsedBalance: Big;
    if (typeof balance === "string") {
        try {
            parsedBalance = Big(balance);
        } catch (error) {
            console.error(
                "[formatBalance] Error parsing balance string:",
                error,
                { balance },
            );
            return "0";
        }
    } else {
        parsedBalance = balance;
    }
    return parsedBalance
        .div(Big(10).pow(decimals))
        .toFixed(displayDecimals, 3)
        .replace(/\.?0+$/, "");
}

export function formatNearAmount(
    amount: string,
    displayDecimals: number = 5,
): string {
    return formatBalance(amount, 24, displayDecimals);
}

/**
 * Format a number with smart precision and thousand separators
 * - For numbers >= 1: shows up to 4 decimals
 * - For numbers < 1: shows up to 8 significant figures
 *
 * @param value - The value to format (number, string, or Big)
 * @returns Formatted string with smart precision and thousand separators
 *
 * @example
 * formatSmartAmount(1234.5678) => "1,234.5678"
 * formatSmartAmount(0.000123456) => "0.00012346"
 * formatSmartAmount(0.00000000012) => "0.00000000012"
 */
export function formatSmartAmount(value: number | string | Big): string {
    const num =
        typeof value === "number" || typeof value === "string"
            ? parseFloat(value.toString())
            : parseFloat(value.toString());

    // Handle zero
    if (num === 0) return "0";

    const absNum = Math.abs(num);
    const absBig =
        typeof value === "object" && "toFixed" in value
            ? value.abs()
            : Big(absNum.toString());

    let formatted: string;

    // For numbers >= 1, show up to 4 decimals (min 2)
    if (absNum >= 1) {
        formatted = absBig.toFixed(4).replace(/(\.\d{2,}?)0+$/, "$1");
    } else {
        // For small numbers, find first significant digit and show up to 8 significant figures
        const str = absNum.toExponential();
        const [, exponent] = str.split("e");
        const exp = Math.abs(parseInt(exponent));

        // Show enough decimals to display ~6-8 significant figures
        const decimalPlaces = Math.min(exp + 6, 30);
        formatted = absBig
            .toFixed(decimalPlaces)
            .replace(/(\.\d{2,}?)0+$/, "$1");
    }

    // Add thousands separator using locale formatting
    const parts = formatted.split(".");
    const integerPart = parseInt(parts[0]).toLocaleString();
    return parts[1] ? `${integerPart}.${parts[1]}` : integerPart;
}

/**
 * Format token amounts with smart fractional precision and grouped integer part.
 * Uses formatSmartAmount for decimal precision strategy.
 */
export function formatTokenDisplayAmount(value: number | string | Big): string {
    let normalized = "";

    try {
        if (typeof value === "string") {
            const trimmed = value.trim();
            normalized = trimmed.replace(/,/g, "").replace(/^\+/, "");
        } else {
            normalized = value.toString();
        }

        const parsed = Big(normalized || "0");
        const absFormatted = formatSmartAmount(parsed.abs());

        if (parsed.lt(0)) return `-${absFormatted}`;
        return absFormatted;
    } catch {
        return "0";
    }
}

/**
 * Format an activity amount with sign (+/-) for display in transaction lists
 * Uses smart precision: 4 decimals for amounts >= 1, up to 8 significant figures for smaller amounts
 * NOTE: Expects amount to already be in human-readable format (e.g., "0.000123" NEAR, not yoctoNEAR)
 *
 * @param amount - The amount in human-readable format (positive for received, negative for sent)
 * @returns Formatted amount with sign and smart precision, e.g., "+1,234.5678" or "-0.000123"
 */
export function formatActivityAmount(amount: string): string {
    try {
        const parsed = Big(amount);
        if (parsed.eq(0)) return "+0";
        const absFormatted = formatTokenDisplayAmount(parsed.abs());
        return parsed.gt(0) ? `+${absFormatted}` : `-${absFormatted}`;
    } catch {
        return "+0";
    }
}

/**
 * Decodes base64 encoded function call arguments
 * @param args - Base64 encoded string
 * @returns Parsed JSON object or null if decoding fails
 */
export function decodeArgs(args: string): any {
    try {
        const decoded = atob(args);
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * Parse key to readable format (snake_case/camelCase -> Title Case)
 */
export const parseKeyToReadableFormat = (key: string) => {
    return key
        .replace(/_/g, " ") // Replace underscores with spaces
        .replace(/([a-z])([A-Z])/g, "$1 $2") // Add spaces between camelCase or PascalCase words
        .replace(/\b\w/g, (c) => c.toUpperCase()); // Capitalize each word
};

/**
 * Encode data object to markdown format for DAO proposals
 */
export const encodeToMarkdown = (data: any) => {
    return Object.entries(data)
        .filter(([key, value]) => {
            return (
                key && // Key exists and is not null/undefined
                value !== null &&
                value !== undefined &&
                value !== ""
            );
        })
        .map(([key, value]) => {
            return `* ${parseKeyToReadableFormat(key)}: ${String(value)}`;
        })
        .join(" <br>");
};

/**
 * Decode proposal description to extract specific key value
 * Supports both JSON and markdown formats
 */
export const decodeProposalDescription = (key: string, description: string) => {
    // Try to parse as JSON
    let parsedData;
    try {
        parsedData = JSON.parse(description);
        if (parsedData && parsedData[key] !== undefined) {
            return parsedData[key]; // Return value from JSON if key exists
        }
    } catch (error) {
        // Not JSON, proceed to parse as markdown
    }

    // Handle as markdown
    const markdownKey = parseKeyToReadableFormat(key);

    const lines = description.split("<br>");
    for (const line of lines) {
        if (line.startsWith("* ")) {
            const rest = line.slice(2);
            const indexOfColon = rest.indexOf(":");
            if (indexOfColon !== -1) {
                const currentKey = rest.slice(0, indexOfColon).trim();
                const value = rest.slice(indexOfColon + 1).trim();

                if (currentKey.toLowerCase() === markdownKey.toLowerCase()) {
                    return value;
                }
            }
        }
    }

    return undefined;
};

/** Convert a nanosecond timestamp/duration (string) to milliseconds. */
export function nanosToMs(nanoseconds: string): number {
    return Big(nanoseconds).div(1_000_000).toNumber();
}

/** Convert milliseconds to a nanosecond string. */
export function msToNanos(ms: number): string {
    return Big(Math.round(ms)).times(1_000_000).toFixed(0);
}

/**
 * Normalize asset ids for NEAR FT comparisons.
 *
 * Some code paths use prefixed ids (e.g. "nep141:token.near") while others
 * use bare contract ids ("token.near"). This helper makes those comparable.
 */
export function normalizeNearAssetId(value?: string | null): string {
    const normalized = (value || "").trim().toLowerCase();
    return normalized.startsWith("nep141:")
        ? normalized.slice("nep141:".length)
        : normalized;
}

/**
 * Canonicalize token IDs across intents / NEAR prefixes for matching.
 *
 * Examples:
 * - intents.near:nep245:v2_1.omni.hot.tg:56_... -> v2_1.omni.hot.tg:56_...
 * - nep245:v2_1.omni.hot.tg:56_... -> v2_1.omni.hot.tg:56_...
 * - nep141:wrap.near -> wrap.near
 */
export function canonicalizeTokenIdForMatch(value?: string | null): string {
    return normalizeNearAssetId(value)
        .replace(/^intents\.near:/i, "")
        .replace(/^nep245:/i, "")
        .toLowerCase();
}

/**
 * Returns a human-readable NEAR token type label based on the tokenId.
 * - "" or "near" → "NEAR (Native Token)"
 * - starts with "nep141:" or "nep245:" → "NEAR (near.com)" or "near.com"
 * - anything else (contract address) → "NEAR (Fungible Token)"
 *
 * Returns null for non-NEAR networks so callers can fall back to the chain name.
 */
export function getNearTokenTypeLabel(
    tokenId: string,
    network?: string,
    options?: { expandNearComLabel?: boolean },
): string | null {
    const resolvedNetwork = network?.toLowerCase() ?? NEAR_NETWORK_ID;
    if (resolvedNetwork !== NEAR_NETWORK_ID) return null;

    const id = tokenId.toLowerCase();
    if (id === "" || id === NEAR_NETWORK_ID) return "NEAR (Native Token)";
    if (id.startsWith("nep141:") || id.startsWith("nep245:")) {
        return options?.expandNearComLabel === false
            ? "near.com"
            : "NEAR (near.com)";
    }
    return "NEAR (Fungible Token)";
}

/**
 * Format nanoseconds to human-readable duration
 * @param nanoseconds - Duration in nanoseconds as string
 * @returns Human-readable duration string (e.g., "7 days", "2 weeks, 3 days", "5 hours")
 */
export function formatNanosecondDuration(nanoseconds: string): string {
    const ns = BigInt(nanoseconds);

    // Convert to different units
    const seconds = Number(ns / BigInt(1_000_000_000));
    const minutes = seconds / 60;
    const hours = minutes / 60;
    const days = hours / 24;

    if (days >= 1) {
        const wholeDays = Math.floor(days);
        const remainingHours = Math.floor(hours % 24);
        if (remainingHours > 0) {
            return `${wholeDays} day${wholeDays !== 1 ? "s" : ""}, ${remainingHours} hour${remainingHours !== 1 ? "s" : ""}`;
        }
        return `${wholeDays} day${wholeDays !== 1 ? "s" : ""}`;
    } else if (hours >= 1) {
        const wholeHours = Math.floor(hours);
        return `${wholeHours} hour${wholeHours !== 1 ? "s" : ""}`;
    } else if (minutes >= 1) {
        const wholeMinutes = Math.floor(minutes);
        return `${wholeMinutes} minute${wholeMinutes !== 1 ? "s" : ""}`;
    } else {
        return `${seconds} second${seconds !== 1 ? "s" : ""}`;
    }
}

/**
 * Format seconds using Intl.DurationFormat.
 * Returns null when input is invalid.
 */
export function formatDurationSeconds(
    value: number | string | null | undefined,
    locale: string,
): string | null {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return null;

    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    const formatter = new (Intl as any).DurationFormat(locale, {
        style: "long",
    });
    const duration: Record<string, number> = {};
    if (hours > 0) duration.hours = hours;
    if (minutes > 0) duration.minutes = minutes;
    if (remainingSeconds > 0 || Object.keys(duration).length === 0) {
        duration.seconds = remainingSeconds;
    }
    return formatter.format(duration);
}

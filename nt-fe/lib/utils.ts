import Big from "big.js";
import { clsx, type ClassValue } from "clsx";
import { format } from "date-fns";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function toBase64(json: any) {
    return Buffer.from(JSON.stringify(json)).toString("base64");
}

export function formatCurrency(value: number | Big) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
    }).format(typeof value === "number" ? value : Number(value.toString()));
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
    date: Date | string | number,
    options: FormatUserDateOptions = {},
): string {
    if (!date) return "";

    const {
        timezone = null,
        timeFormat = "12",
        includeTime = true,
        includeTimezone = true,
        customFormat,
    } = options;

    // Convert to Date object
    let dateObj: Date;
    if (typeof date === "string" || typeof date === "number") {
        dateObj = new Date(date);
    } else {
        dateObj = date;
    }

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
        .toFixed(displayDecimals)
        .replace(/\.?0+$/, "");
}

export function formatNearAmount(
    amount: string,
    displayDecimals: number = 5,
): string {
    return formatBalance(amount, 24, displayDecimals);
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

    return null; // Return null if key not found
};

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

import Big from "big.js";
import { clsx, type ClassValue } from "clsx"
import { format } from "date-fns";
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function toBase64(json: any) {
  return Buffer.from(JSON.stringify(json)).toString("base64");
}


export function formatTimestamp(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime() * 1000000;
}

export function formatDate(date: Date | string | number) {
  if (!date) return "";
  if (typeof date === "string" || typeof date === "number") {
    date = new Date(date);
  }

  // Get timezone offset in minutes
  const timezoneOffset = date.getTimezoneOffset();

  // Calculate hours and minutes
  const offsetHours = Math.abs(Math.floor(timezoneOffset / 60));
  const offsetMinutes = Math.abs(timezoneOffset % 60);

  // Determine timezone string
  let timezoneStr = "UTC";
  if (timezoneOffset !== 0) {
    const sign = timezoneOffset > 0 ? "-" : "+";
    timezoneStr = `UTC${sign}${offsetHours}${offsetMinutes > 0 ? `:${offsetMinutes.toString().padStart(2, "0")}` : ""}`;
  }

  return `${format(date, "MMM dd, yyyy HH:mm")} ${timezoneStr}`;
}

export function formatGas(gas: string): string {
  return `${formatBalance(gas, 12, 2)}`;
}

export function formatBalance(balance: string | Big, decimals: number, displayDecimals: number = 5): string {

  let parsedBalance: Big;
  if (typeof balance === "string") {
    parsedBalance = Big(balance);
  } else {
    parsedBalance = balance;
  }
  return (
    parsedBalance.div(Big(10).pow(decimals)).toFixed(displayDecimals).replace(/\.?0+$/, "")
  );
}

export function formatNearAmount(amount: string, displayDecimals: number = 5): string {
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
  const weeks = days / 7;

  if (weeks >= 1) {
    const wholeWeeks = Math.floor(weeks);
    const remainingDays = Math.floor(days % 7);
    if (remainingDays > 0) {
      return `${wholeWeeks} week${wholeWeeks !== 1 ? 's' : ''}, ${remainingDays} day${remainingDays !== 1 ? 's' : ''}`;
    }
    return `${wholeWeeks} week${wholeWeeks !== 1 ? 's' : ''}`;
  } else if (days >= 1) {
    const wholeDays = Math.floor(days);
    const remainingHours = Math.floor(hours % 24);
    if (remainingHours > 0) {
      return `${wholeDays} day${wholeDays !== 1 ? 's' : ''}, ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`;
    }
    return `${wholeDays} day${wholeDays !== 1 ? 's' : ''}`;
  } else if (hours >= 1) {
    const wholeHours = Math.floor(hours);
    return `${wholeHours} hour${wholeHours !== 1 ? 's' : ''}`;
  } else if (minutes >= 1) {
    const wholeMinutes = Math.floor(minutes);
    return `${wholeMinutes} minute${wholeMinutes !== 1 ? 's' : ''}`;
  } else {
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }
}

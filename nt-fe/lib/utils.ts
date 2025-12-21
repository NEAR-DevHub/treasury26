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

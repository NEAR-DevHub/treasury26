import Papa from "papaparse";
import { MAX_RECIPIENTS_PER_BULK_PAYMENT } from "@/lib/bulk-payment-api";
import {
  validateNearAddress,
  isValidNearAddressFormat,
} from "@/lib/near-validation";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import type { BulkPaymentData } from "../schemas";
import type { TreasuryAsset } from "@/lib/api";

/**
 * Common Papa Parse configuration
 */
const PAPA_PARSE_CONFIG: Papa.ParseConfig = {
  delimiter: "", // auto-detect delimiter (tries comma, tab, pipe, semicolon, etc.)
  skipEmptyLines: "greedy", // Skip lines with only whitespace
  header: false, // We want arrays, not objects
  dynamicTyping: false, // Keep everything as strings for consistent parsing
};

/**
 * Check if Papa Parse result has critical errors
 */
function hasCriticalParseErrors(errors: Papa.ParseError[]): boolean {
  const criticalErrors = errors.filter(
    (err) => err.type === "FieldMismatch" || err.type === "Quotes"
  );
  return criticalErrors.length > 0;
}

/**
 * Parse CSV or paste data using Papa Parse
 */
export function parseCsv(raw: string): string[][] {
  if (!raw.trim()) return [];

  const result = Papa.parse<string[]>(raw, PAPA_PARSE_CONFIG);

  // Check for critical parsing errors
  if (result.errors && result.errors.length > 0) {
    console.warn("CSV parsing errors:", result.errors);
    if (hasCriticalParseErrors(result.errors)) {
      console.error("Critical CSV parsing errors:", result.errors);
      throw new Error("Failed to parse CSV data. Please check formatting.");
    }
  }

  return result.data.filter((row: any) => row && row.length > 0);
}

/**
 * Detect if the first row/line is a header and return parsing configuration
 * Handles both paste data (string array) and CSV data (2D array)
 */
export function detectHeaderAndGetConfig(data: string[] | string[][]): {
  hasHeader: boolean;
  startRow: number;
  recipientIdx: number;
  amountIdx: number;
} {
  if (data.length === 0) {
    return { hasHeader: false, startRow: 0, recipientIdx: 0, amountIdx: 1 };
  }

  const firstItem = data[0];

  // Case 1: Array of strings (paste data - raw lines)
  if (typeof firstItem === "string") {
    const firstLine = firstItem.toLowerCase().trim();
    const hasHeader =
      firstLine.includes("recipient") &&
      (firstLine.includes("amount") || firstLine.includes("value"));
    return {
      hasHeader,
      startRow: hasHeader ? 1 : 0,
      recipientIdx: 0,
      amountIdx: 1,
    };
  }

  // Case 2: Array of arrays (CSV data - parsed cells)
  if (Array.isArray(firstItem)) {
    const firstRow = firstItem as string[];
    const hasHeader = firstRow.some((cell) => {
      const cellLower = (cell || "").trim().toLowerCase();
      return (
        cellLower.startsWith("recipient") || cellLower.startsWith("amount")
      );
    });

    if (hasHeader) {
      const colIdx = (name: string) =>
        firstRow.findIndex((h) =>
          (h || "").trim().toLowerCase().startsWith(name.toLowerCase())
        );

      const recipientIdx = colIdx("Recipient");
      const amountIdx = colIdx("Amount");

      return {
        hasHeader: true,
        startRow: 1,
        recipientIdx,
        amountIdx,
      };
    }

    return {
      hasHeader: false,
      startRow: 0,
      recipientIdx: 0,
      amountIdx: 1,
    };
  }

  return { hasHeader: false, startRow: 0, recipientIdx: 0, amountIdx: 1 };
}

/**
 * Parse amount string handling different formats and decimal separators
 */
export function parseAmount(amountStr: string): number {
  // Remove spaces, currency symbols, and underscores (used as thousand separators)
  let normalized = amountStr.trim().replace(/[$€£¥_\s]/g, "");

  // Handle empty or invalid input
  if (!normalized) return NaN;

  // Handle different decimal separators
  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    // Both separators present: last one is decimal, others are thousands
    const lastCommaIndex = normalized.lastIndexOf(",");
    const lastDotIndex = normalized.lastIndexOf(".");

    if (lastDotIndex > lastCommaIndex) {
      // Dot is decimal: "1,000.50" -> "1000.50"
      normalized = normalized.replace(/,/g, "");
    } else {
      // Comma is decimal: "1.000,50" -> "1000.50"
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    }
  } else if (hasComma) {
    // Only comma: check if it's decimal or thousands separator
    const parts = normalized.split(",");
    if (parts.length === 2 && parts[1].length <= 8) {
      // Likely decimal separator: "10,5" or "10,50"
      normalized = normalized.replace(",", ".");
    } else {
      // Likely thousands separator: "1,000" or "1,000,000"
      normalized = normalized.replace(/,/g, "");
    }
  }
  // If only dot, keep as-is (standard format)

  return parseFloat(normalized);
}

/**
 * Validate recipient address format
 */
function validateRecipientAddress(address: string): string | null {
  if (!address || address.trim() === "") {
    return "Recipient address is required";
  }

  if (!isValidNearAddressFormat(address)) {
    return "Invalid recipient address.";
  }

  return null;
}

/**
 * Parse payment data from CSV rows
 */
export function parsePaymentData(
  rows: string[][],
  recipientIdx: number,
  amountIdx: number,
  startRow: number
): {
  payments: BulkPaymentData[];
  errors: Array<{ row: number; message: string }>;
} {
  const errors: Array<{ row: number; message: string }> = [];
  const payments: BulkPaymentData[] = [];

  // Parse all rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const actualRowNumber = i + startRow + 1; // Adjust for display

    // Skip empty rows
    if (row.every((cell) => !cell || !cell.trim())) {
      continue;
    }

    // Check if row has enough columns
    if (row.length < 2) {
      errors.push({
        row: actualRowNumber,
        message: `Invalid format. Expected: recipient, amount`,
      });
      continue;
    }

    const recipient = (row[recipientIdx] || "").trim();
    const amountStr = (row[amountIdx] || "").trim();

    // Validate that both recipient and amount exist
    if (!recipient) {
      errors.push({
        row: actualRowNumber,
        message: "Missing recipient address",
      });
      continue;
    }

    if (!amountStr) {
      errors.push({
        row: actualRowNumber,
        message: "Missing amount",
      });
      continue;
    }

    const parsedAmountValue = parseAmount(amountStr);

    // Validate amount is a valid number
    if (isNaN(parsedAmountValue) || parsedAmountValue <= 0) {
      errors.push({
        row: actualRowNumber,
        message: `Invalid amount: ${amountStr}`,
      });
      continue;
    }

    const validationError = validateRecipientAddress(recipient);

    payments.push({
      recipient,
      amount: String(parsedAmountValue),
      validationError: validationError || undefined,
    });
  }

  // Check if there were any parsing errors
  if (errors.length > 0) {
    return { payments: [], errors };
  }

  if (payments.length === 0) {
    return { payments: [], errors: [{ row: 0, message: "No valid data found" }] };
  }

  // Check if exceeds maximum recipients limit
  if (payments.length > MAX_RECIPIENTS_PER_BULK_PAYMENT) {
    return {
      payments: [],
      errors: [
        {
          row: 0,
          message: `Maximum limit of ${MAX_RECIPIENTS_PER_BULK_PAYMENT} transactions per request. Remove ${
            payments.length - MAX_RECIPIENTS_PER_BULK_PAYMENT
          } recipients to proceed.`,
        },
      ],
    };
  }

  return { payments, errors: [] };
}

/**
 * Unified function to parse and validate data (CSV or paste)
 */
function parseAndValidateData(
  input: string,
  errorPrefix: string
): {
  payments: BulkPaymentData[];
  errors: Array<{ row: number; message: string }>;
} {
  try {
    const rows = parseCsv(input);

    if (rows.length === 0) {
      return { payments: [], errors: [{ row: 0, message: "No data provided" }] };
    }

    // Detect header and get column configuration
    const { hasHeader, startRow, recipientIdx, amountIdx } =
      detectHeaderAndGetConfig(rows);

    // If header detected but columns are missing, show error
    if (hasHeader && (recipientIdx === -1 || amountIdx === -1)) {
      return {
        payments: [],
        errors: [
          {
            row: 0,
            message: "Missing one or more required columns: Recipient, Amount",
          },
        ],
      };
    }

    // Extract data rows (skip header if present)
    const dataRows = rows.slice(startRow);

    // Use unified parser
    return parsePaymentData(dataRows, recipientIdx, amountIdx, startRow);
  } catch (error) {
    return {
      payments: [],
      errors: [
        {
          row: 0,
          message:
            error instanceof Error
              ? error.message
              : `Failed to parse ${errorPrefix}`,
        },
      ],
    };
  }
}

/**
 * Parse and validate CSV data
 */
export function parseAndValidateCsv(csvData: string): {
  payments: BulkPaymentData[];
  errors: Array<{ row: number; message: string }>;
} {
  return parseAndValidateData(csvData, "CSV data");
}

/**
 * Parse and validate paste data
 */
export function parseAndValidatePasteData(pasteData: string): {
  payments: BulkPaymentData[];
  errors: Array<{ row: number; message: string }>;
} {
  // Normalize line breaks
  const normalizedInput = pasteData.replace(/\\n/g, "\n").trim();
  return parseAndValidateData(normalizedInput, "paste data");
}

/**
 * Check if token needs storage deposit check
 */
export function needsStorageDepositCheck(token: { residency?: string }): boolean {
  // Intents, Near tokens don't need storage deposits
  // FT tokens need storage deposits
  return token.residency === "Ft";
}

/**
 * Validate accounts and check storage deposits
 */
export async function validateAccountsAndStorage(
  payments: BulkPaymentData[],
  selectedToken: { address: string; residency?: string; }
): Promise<BulkPaymentData[]> {
  // Step 1: Validate account existence
  const accountValidatedPayments = await Promise.all(
    payments.map(async (payment) => {
      try {
        const validationError = await validateNearAddress(payment.recipient);

        return {
          ...payment,
          validationError: validationError || undefined,
        };
      } catch (error) {
        console.error(`Error validating ${payment.recipient}:`, error);
        return {
          ...payment,
          validationError: "Failed to validate account",
        };
      }
    })
  );

  // Step 2: Check storage registration for FT tokens (only for valid accounts)
  if (!needsStorageDepositCheck(selectedToken)) {
    return accountValidatedPayments;
  }

  // Filter only valid accounts
  const validAccounts = accountValidatedPayments.filter(
    (payment) => !payment.validationError
  );

  if (validAccounts.length === 0) {
    return accountValidatedPayments;
  }

  const tokenId = selectedToken.address;

  const storageRequests = validAccounts.map((payment) => ({
    accountId: payment.recipient,
    tokenId: tokenId,
  }));

  const storageRegistrations =
    await getBatchStorageDepositIsRegistered(storageRequests);

  const registrationMap = new Map<string, boolean>();
  storageRegistrations.forEach((reg) => {
    registrationMap.set(
      `${reg.account_id}-${reg.token_id}`,
      reg.is_registered
    );
  });

  return accountValidatedPayments.map((payment) => {
    if (payment.validationError) {
      return payment;
    }

    const key = `${payment.recipient}-${tokenId}`;
    const isRegistered = registrationMap.get(key) ?? false;

    return {
      ...payment,
      isRegistered,
    };
  });
}


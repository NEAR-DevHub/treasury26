import { parseCsv } from "@/lib/csv-utils";
import { MAX_RECIPIENTS_PER_BULK_PAYMENT } from "@/lib/bulk-payment-api";
import {
    validateNearAddress,
    isValidNearAddressFormat,
    type NearValidationErrorCode,
} from "@/lib/near-validation";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import {
    isNearToken,
    getBlockchainType,
    BlockchainType,
} from "@/lib/blockchain-utils";
import {
    getBlockchainDisplayName,
    validateAddress,
} from "@/lib/address-validation";
import {
    estimateIntentsNetworkFee,
    isIntentsCrossChainToken,
} from "@/lib/intents-fee";
import type { BulkPaymentData } from "../schemas";
import Big from "@/lib/big";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

export { parseCsv };

export interface BulkParsingLabels {
    rowPrefix: (row: number, message: string) => string;
    rowPrefixOnly: (row: number) => string;
    missingRecipientFirstColumn: string;
    invalidNearAddress: (address: string) => string;
    invalidChainAddress: (address: string, chain: string) => string;
    rowNeedsAmountRecipient: string;
    missingRecipientBeforeComma: string;
    missingAmountAfterComma: (recipient: string) => string;
    invalidAmountNumber: (amountStr: string) => string;
    amountGreaterThanZero: (amountStr: string) => string;
    amountTooLarge: (amountStr: string) => string;
    invalidAmountFallback: string;
    pleaseRemoveChars: (chars: string) => string;
    amountCannotBeEmpty: string;
    tokenMismatch: (
        provided: string,
        expected: string,
        suggested: string,
    ) => string;
    multipleTokenSymbols: (symbols: string) => string;
    noPaymentDataFound: string;
    exceedsRecipientLimit: (
        count: number,
        limit: number,
        excess: number,
    ) => string;
    noPaymentDataProvided: string;
    headerColumnsNotFound: string;
    failedToParseCsv: string;
    failedToParsePaste: string;
    failedToValidateAccount: string;
    nearValidationError: (errorCode: NearValidationErrorCode) => string;
    feeEstimationFailed: string;
    feeEstimationFailedRow: (row: number, recipient: string) => string;
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
        // More flexible header detection
        const hasRecipientHeader =
            firstLine.includes("recipient") ||
            firstLine.includes("wallet") ||
            firstLine.includes("receiver") ||
            firstLine.includes("address");
        const hasAmountHeader =
            firstLine.includes("amount") ||
            firstLine.includes("value") ||
            firstLine.includes("token");
        const hasHeader = hasRecipientHeader && hasAmountHeader;
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
                cellLower.startsWith("recipient") ||
                cellLower.startsWith("amount") ||
                cellLower.startsWith("wallet") ||
                cellLower.startsWith("receiver") ||
                cellLower.startsWith("address") ||
                cellLower.startsWith("value")
            );
        });

        if (hasHeader) {
            const colIdx = (names: string[]) =>
                firstRow.findIndex((h) => {
                    const cellLower = (h || "").trim().toLowerCase();
                    return names.some((name) =>
                        cellLower.startsWith(name.toLowerCase()),
                    );
                });

            const recipientIdx = colIdx([
                "Recipient",
                "Wallet",
                "Receiver",
                "Address",
            ]);
            const amountIdx = colIdx(["Amount", "Value", "Token"]);

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
 * Extract token symbol from amount string
 * Handles various formats:
 * - "100 NEAR" -> "NEAR"
 * - "100NEAR" -> "NEAR"
 * - "100 near" -> "NEAR" (case insensitive)
 * - "100.5  NEAR" -> "NEAR" (multiple spaces)
 * Returns null if no token symbol is found
 */
export function extractTokenSymbol(amountStr: string): string | null {
    const trimmed = amountStr.trim();
    // Match token symbol at the end (letters only, 2-10 chars, with or without space)
    // This regex handles: "100 NEAR", "100NEAR", "100.5NEAR", etc.
    const match = trimmed.match(/\s*([A-Za-z]{2,10})$/);
    return match ? match[1].toUpperCase() : null;
}

/**
 * Parse amount string handling different formats and decimal separators
 * Returns a normalized string that can be safely used with Big.js
 * Also extracts token symbol if present
 *
 * Accepts various formats:
 * - "100" / "100.50" / "100,50"
 * - "100 NEAR" / "100NEAR" / "100 near" (with/without space, case insensitive)
 * - "1,000.50" / "1.000,50" (thousand separators)
 *
 * ONLY allows: digits, comma, dot, spaces, and letters (for token symbols)
 * REJECTS: currency symbols ($, €, etc.), special characters
 */
export function parseAmount(
    amountStr: string,
    labels: Pick<
        BulkParsingLabels,
        "pleaseRemoveChars" | "amountCannotBeEmpty"
    >,
): {
    amount: string;
    tokenSymbol: string | null;
    error?: string;
} {
    const trimmed = amountStr.trim();

    // Check for invalid characters BEFORE processing
    // Allow: digits (0-9), comma, dot, space, letters (for token symbols), and plus sign at start
    const invalidChars = trimmed.match(/[^0-9,.\s\+A-Za-z]/g);
    if (invalidChars) {
        const uniqueChars = [...new Set(invalidChars)].join(", ");
        return {
            amount: "",
            tokenSymbol: null,
            error: labels.pleaseRemoveChars(uniqueChars),
        };
    }

    // Extract token symbol if present (e.g., "100 NEAR" or "100NEAR")
    const tokenSymbol = extractTokenSymbol(trimmed);

    // Remove token symbol from the string (with or without space)
    let normalized = tokenSymbol
        ? trimmed.replace(new RegExp(`\\s*${tokenSymbol}$`, "i"), "").trim()
        : trimmed;

    // Remove leading plus sign if present
    if (normalized.startsWith("+")) {
        normalized = normalized.substring(1);
    }

    // Remove spaces and underscores (used as thousand separators)
    normalized = normalized.replace(/[_\s]/g, "");

    // Handle empty or invalid input
    if (!normalized)
        return { amount: "", tokenSymbol, error: labels.amountCannotBeEmpty };

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
        // Only comma: check if it's a decimal or a thousands separator.
        const parts = normalized.split(",");
        // A single comma group of exactly 3 digits is the canonical
        // thousands grouping ("1,000" -> 1000), so it must not be treated
        // as a decimal, unless the integer part is "0" ("0,500" -> 0.5),
        // which is only meaningful as a decimal. Any other single group
        // length (1, 2 or 4+ digits) is a decimal separator: "10,5",
        // "10,50", "1,2345".
        const isThousandsGroup =
            parts.length === 2 && parts[1].length === 3 && parts[0] !== "0";
        if (parts.length === 2 && !isThousandsGroup) {
            // Decimal separator: "10,5" or "10,50"
            normalized = normalized.replace(",", ".");
        } else {
            // Thousands separator: "1,000" or "1,000,000"
            normalized = normalized.replace(/,/g, "");
        }
    }
    // If only dot, keep as-is (standard format)

    return { amount: normalized, tokenSymbol };
}

/**
 * Validate recipient address format based on blockchain
 * Returns user-friendly error messages with actionable guidance
 */
function validateRecipientAddress(
    address: string,
    blockchainType: string = NEAR_NETWORK_ID,
    labels: Pick<
        BulkParsingLabels,
        | "missingRecipientFirstColumn"
        | "invalidNearAddress"
        | "invalidChainAddress"
    >,
): string | null {
    if (!address || address.trim() === "") {
        return labels.missingRecipientFirstColumn;
    }

    // For NEAR blockchain, use NEAR-specific validation
    if (blockchainType === NEAR_NETWORK_ID) {
        if (!isValidNearAddressFormat(address)) {
            return labels.invalidNearAddress(address);
        }
        return null;
    }

    const result = validateAddress(address, blockchainType as any);
    if (result.error) {
        return labels.invalidChainAddress(
            address,
            getBlockchainDisplayName(blockchainType as BlockchainType),
        );
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
    startRow: number,
    labels: BulkParsingLabels,
    blockchain: string = NEAR_NETWORK_ID,
    expectedTokenSymbol?: string,
): {
    payments: BulkPaymentData[];
    errors: Array<{ row: number; message: string }>;
} {
    const errors: Array<{ row: number; message: string }> = [];
    const payments: BulkPaymentData[] = [];
    const tokenSymbolsFound = new Set<string>();

    // Parse all rows
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const actualRowNumber = i + startRow + 1; // Adjust for display (1-indexed for user)

        // Skip empty rows
        if (row.every((cell) => !cell || !cell.trim())) {
            continue;
        }

        // Check if row has enough columns
        if (row.length < 2) {
            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(
                    actualRowNumber,
                    labels.rowNeedsAmountRecipient,
                ),
            });
            continue;
        }

        const recipient = (row[recipientIdx] || "").trim();

        // Join all remaining columns as the amount (handles cases like "2,500.75" split by comma delimiter)
        // This way "dave.near,2,500.75" which gets split to ["dave.near", "2", "500.75"]
        // will be reconstructed as "2,500.75"
        const amountParts = row
            .slice(amountIdx)
            .filter((part) => part && part.trim());
        const amountStr = amountParts.join(",").trim();

        // Validate that both recipient and amount exist
        if (!recipient) {
            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(
                    actualRowNumber,
                    labels.missingRecipientBeforeComma,
                ),
            });
            continue;
        }

        if (!amountStr) {
            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(
                    actualRowNumber,
                    labels.missingAmountAfterComma(recipient),
                ),
            });
            continue;
        }

        const parsedResult = parseAmount(amountStr, labels);

        // Check if parseAmount returned an error (invalid characters)
        if (parsedResult.error) {
            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(actualRowNumber, parsedResult.error),
            });
            continue;
        }

        const parsedAmountStr = parsedResult.amount;
        const tokenSymbol = parsedResult.tokenSymbol;

        // Track token symbols found
        if (tokenSymbol) {
            tokenSymbolsFound.add(tokenSymbol);
        }

        // Validate token symbol matches expected token (if provided)
        if (
            expectedTokenSymbol &&
            tokenSymbol &&
            tokenSymbol !== expectedTokenSymbol.toUpperCase()
        ) {
            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(
                    actualRowNumber,
                    labels.tokenMismatch(
                        tokenSymbol,
                        expectedTokenSymbol.toUpperCase(),
                        tokenSymbol,
                    ),
                ),
            });
            continue;
        }

        // Validate amount is a valid number
        let parsedAmount: Big;
        try {
            if (!parsedAmountStr) {
                throw new Error(labels.invalidAmountNumber(amountStr));
            }
            parsedAmount = Big(parsedAmountStr);

            // Validate amount is positive
            if (parsedAmount.lte(0)) {
                throw new Error(labels.amountGreaterThanZero(amountStr));
            }

            // Validate amount doesn't exceed safe limit
            const MAX_SAFE = Big(Number.MAX_SAFE_INTEGER);
            if (parsedAmount.gt(MAX_SAFE)) {
                throw new Error(labels.amountTooLarge(amountStr));
            }
        } catch (error) {
            // Clean up error message - remove any technical jargon
            let errorMessage =
                error instanceof Error
                    ? error.message
                    : labels.invalidAmountFallback;
            // Strip technical prefixes like "[big.js]" or "Error:"
            errorMessage = errorMessage
                .replace(/^\[.*?\]\s*/, "")
                .replace(/^Error:\s*/i, "");

            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(actualRowNumber, errorMessage),
            });
            continue;
        }

        const validationError = validateRecipientAddress(
            recipient,
            blockchain,
            labels,
        );
        if (validationError) {
            errors.push({
                row: actualRowNumber,
                message: labels.rowPrefix(actualRowNumber, validationError),
            });
            continue;
        }

        payments.push({
            row: actualRowNumber,
            recipient,
            amount: parsedAmountStr, // Store as string to preserve precision
            validationError: validationError || undefined,
        });
    }

    // Check if multiple different token symbols were used
    if (tokenSymbolsFound.size > 1) {
        const symbols = Array.from(tokenSymbolsFound).join(", ");
        errors.push({
            row: 0,
            message: labels.multipleTokenSymbols(symbols),
        });
    }

    // Check if there were any parsing errors
    if (errors.length > 0) {
        return { payments: [], errors };
    }

    if (payments.length === 0) {
        return {
            payments: [],
            errors: [
                {
                    row: 0,
                    message: labels.noPaymentDataFound,
                },
            ],
        };
    }

    // Check if exceeds maximum recipients limit
    if (payments.length > MAX_RECIPIENTS_PER_BULK_PAYMENT) {
        const excess = payments.length - MAX_RECIPIENTS_PER_BULK_PAYMENT;
        return {
            payments: [],
            errors: [
                {
                    row: 0,
                    message: labels.exceedsRecipientLimit(
                        payments.length,
                        MAX_RECIPIENTS_PER_BULK_PAYMENT,
                        excess,
                    ),
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
    fallbackParseErrorMessage: string,
    labels: BulkParsingLabels,
    blockchain: string = NEAR_NETWORK_ID,
    expectedTokenSymbol?: string,
): {
    payments: BulkPaymentData[];
    errors: Array<{ row: number; message: string }>;
} {
    try {
        const rows = parseCsv(input, labels.failedToParseCsv);

        if (rows.length === 0) {
            return {
                payments: [],
                errors: [
                    {
                        row: 0,
                        message: labels.noPaymentDataProvided,
                    },
                ],
            };
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
                        row: 1,
                        message: labels.headerColumnsNotFound,
                    },
                ],
            };
        }

        // Extract data rows (skip header if present)
        const dataRows = rows.slice(startRow);

        // Use unified parser with blockchain parameter
        return parsePaymentData(
            dataRows,
            recipientIdx,
            amountIdx,
            startRow,
            labels,
            blockchain,
            expectedTokenSymbol,
        );
    } catch (error) {
        const errorMsg =
            error instanceof Error ? error.message : fallbackParseErrorMessage;
        return {
            payments: [],
            errors: [
                {
                    row: 0,
                    message: errorMsg,
                },
            ],
        };
    }
}

/**
 * Parse and validate CSV data
 *
 * `destinationNetwork` overrides the token's own network for address
 * validation — used by confidential bulk where the recipient chain is
 * decoupled from the source token's residency.
 */
export function parseAndValidateCsv(
    csvData: string,
    labels: BulkParsingLabels,
    selectedToken?: { symbol?: string; network?: string; residency?: string },
    destinationNetwork?: string,
): {
    payments: BulkPaymentData[];
    errors: Array<{ row: number; message: string }>;
} {
    const networkForValidation = destinationNetwork ?? selectedToken?.network;
    const blockchain = networkForValidation
        ? getBlockchainType(networkForValidation)
        : NEAR_NETWORK_ID;
    const tokenSymbol = selectedToken?.symbol;
    return parseAndValidateData(
        csvData,
        labels.failedToParseCsv,
        labels,
        blockchain,
        tokenSymbol,
    );
}

/**
 * Parse and validate paste data
 */
export function parseAndValidatePasteData(
    pasteData: string,
    labels: BulkParsingLabels,
    selectedToken?: { symbol?: string; network?: string; residency?: string },
    destinationNetwork?: string,
): {
    payments: BulkPaymentData[];
    errors: Array<{ row: number; message: string }>;
} {
    // Normalize line breaks
    const normalizedInput = pasteData.replace(/\\n/g, "\n").trim();
    const networkForValidation = destinationNetwork ?? selectedToken?.network;
    const blockchain = networkForValidation
        ? getBlockchainType(networkForValidation)
        : NEAR_NETWORK_ID;
    const tokenSymbol = selectedToken?.symbol;
    return parseAndValidateData(
        normalizedInput,
        labels.failedToParsePaste,
        labels,
        blockchain,
        tokenSymbol,
    );
}

/**
 * Check if token needs storage deposit check
 */
export function needsStorageDepositCheck(token: {
    residency?: string;
}): boolean {
    // Intents, Near tokens don't need storage deposits
    // FT tokens need storage deposits
    return token.residency === "Ft";
}

/**
 * Validate accounts and check storage deposits
 */
export async function validateAccountsAndStorage(
    payments: BulkPaymentData[],
    selectedToken: { address: string; residency?: string; network?: string },
    labels: Pick<
        BulkParsingLabels,
        "failedToValidateAccount" | "nearValidationError"
    >,
): Promise<BulkPaymentData[]> {
    const isNear = isNearToken(selectedToken.network, selectedToken.residency);

    // Step 1: Validate account existence (only for NEAR)
    if (isNear) {
        const accountValidatedPayments = await Promise.all(
            payments.map(async (payment) => {
                // Skip if already has validation error
                if (payment.validationError) {
                    return payment;
                }

                try {
                    const validationErrorCode = await validateNearAddress(
                        payment.recipient,
                    );
                    const validationError = validationErrorCode
                        ? labels.nearValidationError(validationErrorCode)
                        : null;

                    return {
                        ...payment,
                        validationError: validationError || undefined,
                    };
                } catch (error) {
                    console.error(
                        `Error validating ${payment.recipient}:`,
                        error,
                    );
                    return {
                        ...payment,
                        validationError: labels.failedToValidateAccount,
                    };
                }
            }),
        );

        // Step 2: Check storage registration for FT tokens (only for valid accounts)
        if (!needsStorageDepositCheck(selectedToken)) {
            return accountValidatedPayments;
        }

        // Filter only valid accounts
        const validAccounts = accountValidatedPayments.filter(
            (payment) => !payment.validationError,
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
                `${reg.accountId}-${reg.tokenId}`,
                reg.isRegistered,
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

    // For non-NEAR tokens, validation was done during CSV parsing
    // Just return payments as-is
    return payments;
}

/**
 * Estimate network fee per recipient for cross-chain intents bulk payments.
 * Uses one validated recipient as representative (same destination chain).
 */
export async function validateIntentsFeeCoverage(
    payments: BulkPaymentData[],
    selectedToken: {
        address: string;
        network?: string;
        decimals: number;
        symbol: string;
        minWithdrawalAmount?: string;
    },
    labels: Pick<
        BulkParsingLabels,
        "feeEstimationFailed" | "feeEstimationFailedRow"
    >,
): Promise<{ payments: BulkPaymentData[]; networkFee: string | null }> {
    if (!isIntentsCrossChainToken(selectedToken)) {
        return { payments, networkFee: null };
    }

    const representativePayment = payments.find((p) => !p.validationError);
    if (!representativePayment) {
        return { payments, networkFee: null };
    }

    const representativeAddress = representativePayment.recipient;
    try {
        const { networkFee } = await estimateIntentsNetworkFee({
            token: {
                address: selectedToken.address,
                decimals: selectedToken.decimals,
                minWithdrawalAmount: selectedToken.minWithdrawalAmount,
            },
            destinationAddress: representativeAddress,
            destinationBlockchain: getBlockchainType(
                selectedToken.network || "unknown",
            ),
        });

        return {
            payments,
            networkFee: networkFee.toString(),
        };
    } catch {
        return {
            payments: payments.map((payment) => {
                if (payment.validationError) {
                    return payment;
                }

                return {
                    ...payment,
                    validationError:
                        payment.row && payment.row > 0
                            ? labels.feeEstimationFailedRow(
                                  payment.row,
                                  payment.recipient,
                              )
                            : labels.feeEstimationFailed,
                };
            }),
            networkFee: null,
        };
    }
}

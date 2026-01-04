/**
 * NEAR Address Validation Utilities
 */

import { checkAccountExists } from "./api";

/**
 * Check if string is a valid 64-character hex string (implicit account)
 */
const isHex64 = (str: string): boolean => /^[0-9a-fA-F]{64}$/.test(str);

/**
 * Validates NEAR address format (local check only, doesn't verify blockchain existence)
 * 
 * NEAR addresses can be:
 * 1. Implicit accounts (64-char hex): e.g., "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de"
 * 2. Named accounts ending with .near: e.g., "alice.near", "app.alice.near"
 * 3. Named accounts ending with .aurora: e.g., "bob.aurora"
 * 4. Named accounts ending with .tg: e.g., "charlie.tg"
 * 
 * @returns null if valid format, error message string if invalid
 */
function validateNearAddressFormat(address: string): string | null {
  if (!address || typeof address !== "string") {
    return "Address is required";
  }

  if (address.length > 64) {
    return "Address must be less than 64 characters";
  }

  // Check if it's a valid implicit account (64-char hex)
  if (isHex64(address)) {
    return null;
  }

  // Check for named accounts with valid TLDs
  if (
    address.endsWith(".near") ||
    address.endsWith(".aurora") ||
    address.endsWith(".tg")
  ) {
    return null;
  }

  return "Address must end with .near, .aurora, or .tg, or be a 64-character hex address";
}

/**
 * Validates a NEAR address and returns an error message if invalid, or null if valid.
 * Performs both format validation and blockchain existence check.
 * Note: Implicit accounts (64-char hex) skip blockchain check as they're always valid.
 * 
 * @returns null if valid, error message string if invalid
 */
export async function validateNearAddress(address: string): Promise<string | null> {
  // First check format
  const formatError = validateNearAddressFormat(address);
  if (formatError) {
    return formatError;
  }

  // Skip blockchain check for implicit accounts (64-char hex)
  // These are derived from public keys and are always valid
  if (isHex64(address)) {
    return null;
  }

  // For named accounts, check if they exist on blockchain
  try {
    const result = await checkAccountExists(address);
    console.log("result", result);
    if (!result || !result.exists) {
      return "Account does not exist on NEAR blockchain";
    }
  } catch (error) {
    console.error("Error checking account existence:", error);
    return "Failed to verify account existence";
  }

  return null;
}

/**
 * Simple boolean check if address is valid (async version with blockchain check)
 * @returns true if valid, false if invalid
 */
export const isValidNearAddress = async (address: string): Promise<boolean> => {
  const error = await validateNearAddress(address);
  return error === null;
};

/**
 * Synchronous format-only validation (doesn't check blockchain).
 * Use this for quick format checks without async.
 * @returns true if valid format, false if invalid
 */
export const isValidNearAddressFormat = (address: string): boolean => {
  return validateNearAddressFormat(address) === null;
};


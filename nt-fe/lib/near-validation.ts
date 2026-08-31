/**
 * NEAR Address Validation Utilities
 */

import { checkAccountExists } from "./api";
import {
    is0sDeterministicNearAddress,
    isEthImplicitNearAddress,
    isImplicitOrDeterministicNearAddress,
    isValidNearAddressFormat,
    validateNearAddressFormat,
} from "./near-address-format";

export type NearValidationErrorCode =
    | "required"
    | "length"
    | "missingTld"
    | "invalidChars"
    | "accountMissing"
    | "verifyFailed";

export {
    is0sDeterministicNearAddress,
    isEthImplicitNearAddress,
    isValidNearAddressFormat,
};

export async function validateNearAddress(
    address: string,
): Promise<NearValidationErrorCode | null> {
    const formatError = validateNearAddressFormat(address);
    if (formatError) {
        return formatError;
    }

    const trimmed = address.trim();

    if (isImplicitOrDeterministicNearAddress(trimmed)) {
        return null;
    }

    try {
        const result = await checkAccountExists(trimmed);
        if (!result?.exists) {
            return "accountMissing";
        }
    } catch (error) {
        console.error("Error checking account existence:", error);
        return "verifyFailed";
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

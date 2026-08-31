/**
 * Synchronous NEAR address *format* checks. Kept free of API imports so
 * string helpers like `nearcom-address` can load without circling through
 * `lib/api`.
 */

export type NearAddressFormatErrorCode =
    | "required"
    | "length"
    | "missingTld"
    | "invalidChars";

const isHex64 = (str: string): boolean => /^[0-9a-fA-F]{64}$/.test(str);

export const isEthImplicitNearAddress = (str: string): boolean =>
    /^0x[0-9a-fA-F]{40}$/.test(str);

/**
 * Deterministic-account format (`0s` + 20-byte keccak hash as 40 hex chars),
 * e.g. used by EIP-712 wallet contracts. Like implicit accounts, these are
 * valid recipients whether or not they already exist on-chain.
 */
export const is0sDeterministicNearAddress = (str: string): boolean =>
    /^0s[0-9a-fA-F]{40}$/.test(str);

export function isImplicitOrDeterministicNearAddress(address: string): boolean {
    return (
        isHex64(address) ||
        isEthImplicitNearAddress(address) ||
        is0sDeterministicNearAddress(address)
    );
}

export function validateNearAddressFormat(
    address: string,
): NearAddressFormatErrorCode | null {
    if (!address || typeof address !== "string") {
        return "required";
    }

    const trimmed = address.trim();

    if (trimmed.length < 2 || trimmed.length > 64) {
        return "length";
    }

    if (isImplicitOrDeterministicNearAddress(trimmed)) return null;

    if (!trimmed.includes(".")) {
        return "missingTld";
    }

    const validChars = /^[a-z0-9._-]+$/;
    if (!validChars.test(trimmed)) {
        return "invalidChars";
    }

    const validTLDs = [".near", ".aurora", ".tg", ".sweat"];
    const hasValidTLD = validTLDs.some((tld) => trimmed.endsWith(tld));

    if (!hasValidTLD) {
        return "missingTld";
    }

    return null;
}

/** Format-only. Does not check the chain. */
export function isValidNearAddressFormat(address: string): boolean {
    return validateNearAddressFormat(address) === null;
}

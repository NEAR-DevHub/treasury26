"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { LargeInput } from "./large-input";
import {
    getAddressPattern,
    getAddressExample,
    getBlockchainDisplayName,
} from "@/lib/address-validation";
import {
    validateNearAddress,
    isValidNearAddressFormat,
} from "@/lib/near-validation";
import { translateNearValidationError } from "@/lib/near-validation-i18n";
import type { BlockchainType } from "@/lib/blockchain-utils";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

/**
 * Unified Account Input Component
 * Validates recipient addresses for ALL blockchains (NEAR, Bitcoin, Ethereum, etc.)
 *
 * @param {BlockchainType} blockchain - Blockchain type (near, bitcoin, ethereum, etc.)
 * @param {string} value - Current address value
 * @param {Function} setValue - Callback to update value
 * @param {Function} setIsValid - Callback to update validation state
 * @param {boolean} disabled - Whether input is disabled
 * @param {boolean} borderless - Whether to show borderless style
 */

interface AccountInputProps {
    blockchain: BlockchainType;
    value: string;
    setValue: (value: string) => void;
    setIsValid: (isValid: boolean) => void;
    setIsValidating?: (isValidating: boolean) => void; // Expose validation state
    disabled?: boolean;
    borderless?: boolean;
    validateOnMount?: boolean; // Force validation on mount (for edit screens)
}

const AccountInput = ({
    blockchain,
    value,
    setValue,
    setIsValid,
    setIsValidating: setIsValidatingProp,
    disabled = false,
    borderless = false,
    validateOnMount = false,
}: AccountInputProps) => {
    const t = useTranslations("accountInput");
    const [isValidating, setIsValidating] = useState(false);
    const [validationError, setValidationError] = useState<
        string | undefined
    >();
    const [hasValidated, setHasValidated] = useState(false); // Track if validation completed
    const hasUserInteractedRef = useRef(false);

    const isNear = blockchain === NEAR_NETWORK_ID;

    // Get blockchain-specific configuration
    const config = useMemo(() => {
        const example =
            blockchain === NEAR_NETWORK_ID
                ? t("nearExample")
                : getAddressExample(blockchain);
        return {
            placeholder: example
                ? t("placeholderWithExample", { example })
                : t("placeholderNoExample"),
            regex: getAddressPattern(blockchain),
        };
    }, [blockchain, t]);

    // Wrapper to set isValidating and notify parent
    const updateValidationState = useCallback(
        (validating: boolean) => {
            setIsValidating(validating);
            setIsValidatingProp?.(validating);
        },
        [setIsValidatingProp],
    );

    // Reset all validation states
    const resetValidation = useCallback(() => {
        setValidationError(undefined);
        setIsValid(false);
        setHasValidated(false);
        updateValidationState(false);
    }, [setIsValid, updateValidationState]);

    // NEAR full validation (format + blockchain check)
    const validateNearFull = useCallback(
        async (address: string) => {
            if (!address || address.trim() === "") {
                resetValidation();
                return;
            }

            updateValidationState(true);
            setHasValidated(false); // Reset validation state
            try {
                const errorCode = await validateNearAddress(address);
                setValidationError(
                    errorCode
                        ? translateNearValidationError(t, errorCode)
                        : undefined,
                );
                setIsValid(!errorCode);
                setHasValidated(!errorCode); // Only mark as validated if successful
            } catch (err) {
                console.error("NEAR validation error:", err);
                setValidationError(t("failedValidation"));
                setIsValid(false);
                setHasValidated(false);
            } finally {
                updateValidationState(false);
            }
        },
        [setIsValid, updateValidationState, resetValidation, t],
    );

    useEffect(() => {
        const shouldValidate = validateOnMount || hasUserInteractedRef.current;

        if (!shouldValidate) {
            // Don't validate yet - user hasn't interacted
            return;
        }

        if (!value) {
            resetValidation();
            return;
        }

        // NEAR validation (async)
        if (isNear) {
            if (!isValidNearAddressFormat(value)) {
                setValidationError(t("invalidNearFormat"));
                setIsValid(false);
                setHasValidated(false);
                updateValidationState(false);
                return;
            }

            const timeoutId = setTimeout(
                () => {
                    validateNearFull(value);
                },
                validateOnMount ? 0 : 500,
            );

            return () => {
                clearTimeout(timeoutId);
                updateValidationState(false);
            };
        }

        // Non-NEAR validation (sync with regex)
        if (config.regex) {
            const isValid = config.regex.test(value);
            setIsValid(isValid);
            setHasValidated(isValid);
            setValidationError(
                isValid
                    ? undefined
                    : t("invalidChainAddress", {
                          chain: getBlockchainDisplayName(blockchain),
                      }),
            );
        } else {
            // No regex pattern (unknown blockchain) - accept any non-empty address
            setIsValid(true);
            setHasValidated(true);
            setValidationError(undefined);
        }
    }, [
        value,
        blockchain,
        isNear,
        config.regex,
        validateOnMount,
        setIsValid,
        validateNearFull,
        resetValidation,
        updateValidationState,
        t,
    ]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Remove all whitespace to prevent it from being entered
        const val = e.target.value.replace(/\s/g, "");

        // If value hasn't changed after removing whitespace, don't update
        // This prevents validation state reset when user types whitespace
        if (val === value) {
            return;
        }

        setValue(val);
        hasUserInteractedRef.current = true;

        // Immediate validation feedback for NEAR
        if (isNear) {
            setHasValidated(false);
            if (!val) {
                resetValidation();
            } else if (!isValidNearAddressFormat(val)) {
                setValidationError(t("invalidNearFormat"));
                setIsValid(false);
                updateValidationState(false);
            } else {
                setValidationError(undefined);
                setIsValid(false); // Wait for blockchain check
            }
            return;
        }

        // Immediate validation feedback for other blockchains
        if (!val) {
            resetValidation();
            return;
        }

        if (config.regex) {
            const isValid = config.regex.test(val);
            setIsValid(isValid);
            setHasValidated(isValid);
            setValidationError(
                isValid || !val
                    ? undefined
                    : t("invalidChainAddress", {
                          chain: getBlockchainDisplayName(blockchain),
                      }),
            );
        } else {
            // No regex pattern (e.g., unknown blockchain) - accept any non-empty address
            setIsValid(!!val);
            setHasValidated(!!val);
            setValidationError(undefined);
        }
    };

    // Memoized validation state for border styling
    const validationBorderClass = useMemo(() => {
        const trimmedValue = value?.trim();
        if (!trimmedValue) return "";

        if (isNear) {
            if (isValidating) return "border-yellow-500"; // Validating
            if (validationError) return "border-red-500"; // Invalid
            // For NEAR, only show green after full validation passes
            return hasValidated && !validationError ? "border-green-500" : "";
        }

        // For other chains: immediate validation (or accept all if no pattern)
        if (!config.regex) {
            // No validation pattern (unknown blockchain) — no feedback border
            return "";
        }

        const isValid = config.regex.test(trimmedValue);
        return isValid ? "border-green-500" : "border-red-500";
    }, [
        value,
        isValidating,
        validationError,
        hasValidated,
        config.regex,
        isNear,
    ]);

    return (
        <div className="flex flex-col gap-1">
            <LargeInput
                type="text"
                className={validationBorderClass}
                placeholder={config.placeholder}
                value={value || ""}
                onChange={handleChange}
                disabled={disabled || isValidating}
                borderless={borderless}
            />
            {/* Show validation error or status */}
            {value && validationError && !isValidating && (
                <p className="text-xs text-destructive">{validationError}</p>
            )}
            {/* Show validation status */}
            {value && isValidating && (
                <p className="text-xs text-yellow-600">{t("validating")}</p>
            )}
            {value &&
                !isValidating &&
                !validationError &&
                hasValidated &&
                blockchain !== "unknown" && (
                    <p className="text-xs text-green-600">
                        {t("validAddress")}
                    </p>
                )}
        </div>
    );
};

export default AccountInput;

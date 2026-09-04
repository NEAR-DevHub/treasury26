import {
    useState,
    type FocusEventHandler,
    type InputHTMLAttributes,
} from "react";

/**
 * Stop iOS/Safari Contact AutoFill from treating a wallet field as a
 * postal "Home Address". `autocomplete="off"` is not enough when the
 * visible label or placeholder contains the word "address".
 */
export const WALLET_ADDRESS_INPUT_PROPS = {
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "none",
    spellCheck: false,
    inputMode: "text",
    name: "wallet-recipient",
    enterKeyHint: "done",
} satisfies InputHTMLAttributes<HTMLInputElement>;

/** iOS skips Contact AutoFill on read-only fields; clear it on first focus. */
export function useWalletAddressAutofillGuard(
    onFocus?: FocusEventHandler<HTMLInputElement>,
) {
    const [readOnly, setReadOnly] = useState(true);
    return {
        ...WALLET_ADDRESS_INPUT_PROPS,
        readOnly,
        onFocus: ((event) => {
            setReadOnly(false);
            onFocus?.(event);
        }) satisfies FocusEventHandler<HTMLInputElement>,
    };
}

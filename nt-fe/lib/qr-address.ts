import { hasNearComAddressPrefix } from "@/lib/nearcom-address";

/**
 * Pull a bare wallet address out of a QR payload.
 *
 * Receive QRs carry a bare address (this app's deposit QR included), and
 * payment-request QRs use a wallet URI scheme — BIP-21 `bitcoin:addr?amount=`,
 * Solana Pay, EIP-681 `ethereum:0x…@1`. Web links are returned untouched: no
 * convention puts an address in a URL path, so guessing at one would fill the
 * recipient field with something fabricated instead of letting validation
 * reject the payload.
 */
export function extractAddressFromQrPayload(raw: string): string {
    const trimmed = raw.trim().replace(/\s/g, "");
    if (!trimmed) return "";

    // `nearcom:` belongs to the address rather than being a scheme to strip —
    // the near.com route is only recognised with the prefix intact.
    if (hasNearComAddressPrefix(trimmed)) return trimmed;
    if (/^https?:/i.test(trimmed)) return trimmed;

    // ethereum:0xabc@1?… | solana:… | near:… | bitcoin:…
    const schemeMatch = trimmed.match(
        /^[a-zA-Z][a-zA-Z0-9+.-]*:(?:\/\/)?([^/?#@]+)/,
    );
    return schemeMatch?.[1] ?? trimmed;
}

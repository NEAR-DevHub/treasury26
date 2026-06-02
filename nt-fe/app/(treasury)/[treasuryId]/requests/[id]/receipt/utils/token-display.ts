import type { TokenReceiptInfo } from "./receipt-models";

export function getTokenDisplayFields(metadata: TokenReceiptInfo["metadata"]) {
    return {
        symbol: metadata.value?.symbol ?? "",
        icon: metadata.value?.icon ?? "",
        networkIcon: metadata.value?.network?.chainIcons?.icon ?? null,
    };
}

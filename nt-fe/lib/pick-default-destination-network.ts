import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";

export interface DestinationNetworkChoice {
    id: string;
    networkName: string;
}

export interface DestinationHolding {
    id?: string;
    name?: string;
    balanceUSD?: number;
}

function matchesHolding(
    option: DestinationNetworkChoice,
    holding: DestinationHolding,
): boolean {
    const optionId = option.id.trim().toLowerCase();
    const optionNetwork = option.networkName.trim().toLowerCase();
    const holdingId = holding.id?.trim().toLowerCase();
    const holdingName = holding.name?.trim().toLowerCase();
    return (
        (!!holdingId && optionId === holdingId) ||
        (!!holdingName && optionNetwork === holdingName)
    );
}

/**
 * Destination to preselect after a token is chosen:
 * 1) network with the highest USD holding (never near.com)
 * 2) the only non-near.com option
 * 3) the first option in the list
 */
export function pickDefaultDestinationNetwork<
    T extends DestinationNetworkChoice,
>(options: T[], holdings: DestinationHolding[] = []): T | null {
    if (options.length === 0) return null;

    const chainOptions = options.filter(
        (option) => option.id !== NEAR_COM_NETWORK_ID,
    );

    let best: { option: T; usd: number } | null = null;
    for (const option of chainOptions) {
        let usd = 0;
        for (const holding of holdings) {
            if (!matchesHolding(option, holding)) continue;
            usd += holding.balanceUSD ?? 0;
        }
        if (usd > 0 && (!best || usd > best.usd)) {
            best = { option, usd };
        }
    }
    if (best) return best.option;

    if (chainOptions.length === 1) return chainOptions[0];

    return options[0] ?? null;
}

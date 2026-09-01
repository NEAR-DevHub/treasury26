import type { RecentActivity } from "@/lib/api";
import Big from "@/lib/big";

export function isPositiveActivityAmount(amount: string): boolean {
    try {
        return Big(amount).gt(0);
    } catch {
        return false;
    }
}

export function unitPriceUsdForAmount(
    amount: string | null | undefined,
    valueUsd: number | null | undefined,
    fallbackPrice: number | null | undefined,
): Big | null {
    try {
        if (
            amount &&
            valueUsd != null &&
            Number.isFinite(valueUsd) &&
            valueUsd > 0
        ) {
            const quantity = Big(amount).abs();
            if (quantity.gt(0)) return Big(valueUsd.toString()).div(quantity);
        }
    } catch {
        // Fall through to current token metadata.
    }

    return fallbackPrice != null &&
        Number.isFinite(fallbackPrice) &&
        fallbackPrice > 0
        ? Big(fallbackPrice.toString())
        : null;
}

export function activityUnitPriceUsd(activity: RecentActivity): Big | null {
    return unitPriceUsdForAmount(
        activity.amount,
        activity.valueUsd,
        activity.tokenMetadata?.price,
    );
}

export function groupedActivityUnitPriceUsd(
    activities: RecentActivity[],
): Big | null {
    let valuedQuantity = Big(0);
    let totalUsd = Big(0);

    for (const activity of activities) {
        if (
            activity.valueUsd == null ||
            !Number.isFinite(activity.valueUsd) ||
            activity.valueUsd <= 0
        ) {
            continue;
        }
        try {
            const quantity = Big(activity.amount).abs();
            if (quantity.eq(0)) continue;
            valuedQuantity = valuedQuantity.add(quantity);
            totalUsd = totalUsd.add(activity.valueUsd.toString());
        } catch {
            // Ignore malformed rows and use the metadata fallback below.
        }
    }

    if (valuedQuantity.gt(0)) return totalUsd.div(valuedQuantity);
    const fallback = activities.find(
        (activity) =>
            activity.tokenMetadata?.price != null &&
            Number.isFinite(activity.tokenMetadata.price) &&
            activity.tokenMetadata.price > 0,
    )?.tokenMetadata.price;
    return fallback ? Big(fallback.toString()) : null;
}

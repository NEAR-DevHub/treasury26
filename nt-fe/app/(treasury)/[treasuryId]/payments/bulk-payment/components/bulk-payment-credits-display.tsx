import type { BulkPaymentUsageStats } from "@/lib/api";
import type { SubscriptionStatus } from "@/lib/subscription-api";
import {
    getBatchPaymentCreditLimit,
    isTrialPlan,
} from "@/lib/subscription-api";
import { Button } from "@/components/button";

interface BulkPaymentCreditsDisplayProps {
    credits: BulkPaymentUsageStats;
    subscription: SubscriptionStatus;
}

/**
 * Component to display bulk payment credits status with plan information
 * Shows progress bar, credit counts, and appropriate info messages
 */
export function BulkPaymentCreditsDisplay({
    credits,
    subscription,
}: BulkPaymentCreditsDisplayProps) {
    const { creditsAvailable, creditsUsed, totalCredits } = credits;
    const batchPaymentCreditLimit = getBatchPaymentCreditLimit(
        subscription.planConfig,
    );
    const isTrial = isTrialPlan(subscription.planConfig);

    const isUnlimited = batchPaymentCreditLimit === null;

    // Calculate progress percentage
    const progressPercentage = isUnlimited
        ? 0
        : batchPaymentCreditLimit
          ? (creditsUsed / batchPaymentCreditLimit) * 100
          : (creditsUsed / totalCredits) * 100;

    // Format period display
    const periodDisplay = isTrial ? "one-time trial" : "month";

    return (
        <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Bulk Payments</h3>
                <span className="text-sm font-medium border-2 py-1 px-2 rounded-lg">
                    {isUnlimited
                        ? "Unlimited"
                        : `${batchPaymentCreditLimit || totalCredits} / ${periodDisplay}`}
                </span>
            </div>

            {/* Credits Display - Only show if not unlimited */}
            {!isUnlimited && (
                <div className="space-y-2 border-b-[0.2px] border-general-unofficial-border pb-4">
                    <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold">
                            {creditsAvailable} Available
                        </span>
                        <span className="text-muted-foreground text-xs">
                            {creditsUsed} Used
                        </span>
                    </div>

                    {/* Progress bar */}
                    <div className="w-full h-2 bg-general-unofficial-accent rounded-full overflow-hidden">
                        <div
                            className="h-full bg-foreground transition-all"
                            style={{ width: `${progressPercentage}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Upgrade CTA - Only show if not unlimited */}
            {!isUnlimited && (
                <div className="flex items-center justify-between">
                    <span className="text-sm text-secondary-foreground">
                        Looking for more flexibility?
                    </span>
                    <Button
                        variant={creditsAvailable === 0 ? "default" : "outline"}
                        size="sm"
                        className="p-3!"
                    >
                        Upgrade Plan
                    </Button>
                </div>
            )}
        </div>
    );
}

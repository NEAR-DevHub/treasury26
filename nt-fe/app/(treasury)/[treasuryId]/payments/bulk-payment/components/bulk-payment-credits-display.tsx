"use client";

import { useTranslations } from "next-intl";
import type { SubscriptionStatus } from "@/lib/subscription-api";
import {
    getBatchPaymentCreditLimit,
    isTrialPlan,
} from "@/lib/subscription-api";
import { Button } from "@/components/button";
import { CreditsQuotaDisplay } from "@/components/credits-quota-display";
import { APP_CONTACT_US_URL } from "@/constants/config";

interface BulkPaymentCreditsDisplayProps {
    credits: {
        creditsAvailable: number;
        creditsUsed: number;
        totalCredits: number;
    };
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
    const t = useTranslations("bulkPaymentCredits");
    const { creditsAvailable, creditsUsed, totalCredits } = credits;
    const batchPaymentCreditLimit = getBatchPaymentCreditLimit(
        subscription.planConfig,
    );
    const isTrial = isTrialPlan(subscription.planConfig);
    const isFree = subscription.planType === "free";

    const isUnlimited = batchPaymentCreditLimit === null;

    // Format period display
    const periodDisplay = isTrial ? t("oneTimeTrial") : t("month");

    return (
        <div className="space-y-3 min-w-0">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{t("title")}</p>
                <span className="text-xs sm:text-sm font-medium border py-1 px-2 rounded-lg border-general-border bg-general-unofficial-outline whitespace-nowrap">
                    {isUnlimited
                        ? t("unlimited")
                        : t("creditsPerPeriod", {
                              amount: batchPaymentCreditLimit || totalCredits,
                              period: periodDisplay,
                          })}
                </span>
            </div>

            {/* Credits Display - Only show if not unlimited */}
            {!isUnlimited && (
                <CreditsQuotaDisplay
                    creditsAvailable={creditsAvailable}
                    creditsUsed={creditsUsed}
                    creditsTotal={batchPaymentCreditLimit || totalCredits}
                    creditsResetAt={subscription.creditsResetAt}
                    isFree={isFree}
                    isUnlimited={isUnlimited}
                />
            )}

            {/* Upgrade CTA - Only show if not unlimited */}
            {!isUnlimited && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-secondary-foreground">
                        {t("moreFlexibility")}
                    </span>
                    <Button
                        variant={
                            creditsAvailable === 0 ? "default" : "secondary"
                        }
                        className="px-3"
                        size="sm"
                        onClick={() => {
                            window.open(APP_CONTACT_US_URL, "_blank");
                        }}
                    >
                        {t("contactUs")}
                    </Button>
                </div>
            )}
        </div>
    );
}

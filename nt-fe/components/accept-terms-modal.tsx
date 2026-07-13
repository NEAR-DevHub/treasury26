"use client";

import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Button } from "@/components/button";
import { ScrollContainer } from "@/components/scroll-container";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useNear } from "@/stores/near-store";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/constants/config";

interface AcceptTermsModalProps {
    open: boolean;
    variant: "firstTime" | "returning";
}

export function AcceptTermsModal({ open, variant }: AcceptTermsModalProps) {
    const t = useTranslations("acceptTerms");
    const [accepted, setAccepted] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const { acceptTerms } = useNear();
    const isReturningUser = variant === "returning";

    const handleAccept = async () => {
        if (!accepted) return;

        setIsSubmitting(true);
        try {
            await acceptTerms();
        } catch (error) {
            console.error("Failed to accept terms:", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={open}>
            <DialogContent
                className="lg:max-w-lg sm:max-w-sm max-h-[90vh] overflow-hidden"
                onPointerDownOutside={(e) => e.preventDefault()}
                onEscapeKeyDown={(e) => e.preventDefault()}
                onInteractOutside={(e) => e.preventDefault()}
                showCloseButton={false}
            >
                <DialogHeader closeButton={false}>
                    <DialogTitle>
                        {isReturningUser
                            ? t("returningTitle")
                            : t("firstTimeTitle")}
                    </DialogTitle>
                </DialogHeader>

                <ScrollContainer className="flex-1 min-h-0 -mx-3 px-3">
                    {isReturningUser ? (
                        <DialogDescription asChild>
                            <div className="space-y-3 text-sm">
                                <p className="text-muted-foreground">
                                    {t("returningEffectiveDate")}
                                </p>
                                <p className="text-foreground">
                                    {t("returningBody")}
                                </p>
                            </div>
                        </DialogDescription>
                    ) : (
                        <DialogDescription asChild>
                            <div className="space-y-3 text-sm text-muted-foreground">
                                <ul className="space-y-4">
                                    <li>
                                        <p className="text-foreground mb-1">
                                            {t("privacyTitle")}
                                        </p>
                                        {t("privacyBody")}
                                    </li>
                                    <li>
                                        <p className="text-foreground mb-1">
                                            {t("minimalTitle")}
                                        </p>
                                        {t("minimalBody")}
                                    </li>
                                    <li>
                                        <p className="text-foreground mb-1">
                                            {t("noCustodyTitle")}
                                        </p>
                                        {t("noCustodyBody")}
                                    </li>
                                    <li>
                                        <p className="text-foreground mb-1">
                                            {t("publicTitle")}
                                        </p>
                                        {t("publicBody")}
                                    </li>
                                    <li>
                                        <p className="text-foreground mb-1">
                                            {t("responsibilityTitle")}
                                        </p>
                                        {t("responsibilityBody")}
                                    </li>
                                    <li>
                                        <p className="text-foreground mb-1">
                                            {t("futureTitle")}
                                        </p>
                                        {t("futureBody")}
                                    </li>
                                </ul>
                            </div>
                        </DialogDescription>
                    )}
                </ScrollContainer>

                <DialogFooter className="flex-col gap-3 items-stretch sm:flex-col  pt-0">
                    <div className="flex items-start gap-3">
                        <Checkbox
                            id="terms"
                            checked={accepted}
                            className="mt-0.5"
                            onCheckedChange={(checked) =>
                                setAccepted(checked === true)
                            }
                            disabled={isSubmitting}
                        />
                        <Label
                            htmlFor="terms"
                            className="text-sm text-foreground font-normal inline-block leading-relaxed cursor-pointer"
                        >
                            {t.rich("agreement", {
                                terms: (chunks) => (
                                    <Link
                                        href={TERMS_OF_SERVICE_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-primary underline underline-offset-4 hover:text-primary/80"
                                    >
                                        {chunks}
                                    </Link>
                                ),
                                privacy: (chunks) => (
                                    <Link
                                        href={PRIVACY_POLICY_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-primary underline underline-offset-4 hover:text-primary/80"
                                    >
                                        {chunks}
                                    </Link>
                                ),
                            })}
                        </Label>
                    </div>
                    <Button
                        onClick={handleAccept}
                        disabled={!accepted || isSubmitting}
                        className="w-full"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {t("accepting")}
                            </>
                        ) : isReturningUser ? (
                            t("returningAcceptAndContinue")
                        ) : (
                            t("continue")
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

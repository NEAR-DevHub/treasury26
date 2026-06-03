"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { APP_ACTIVE_TREASURY } from "@/constants/config";
import { trackEvent } from "@/lib/analytics";

interface CreateTreasuryPromptModalProps {
    open: boolean;
    source: "onboarding" | "app";
    showDisconnectWallet?: boolean;
    onOpenChange: (open: boolean) => void;
    onCreateTreasury: () => void;
    onDisconnectWallet?: () => Promise<void> | void;
}

export function CreateTreasuryPromptModal({
    open,
    source,
    showDisconnectWallet = false,
    onOpenChange,
    onCreateTreasury,
    onDisconnectWallet,
}: CreateTreasuryPromptModalProps) {
    const t = useTranslations("onboarding.createPrompt");
    const tSignIn = useTranslations("signIn");
    const isOnboardingPath = source === "onboarding";
    const descriptionSuffix = isOnboardingPath
        ? t("suffixDemo")
        : t("suffixExploring");

    const trackClick = (button: string) => {
        trackEvent("onboarding_cta_clicked", {
            cta: button,
            source: source === "onboarding" ? "/" : "app",
        });
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && isOnboardingPath) return;
                onOpenChange(nextOpen);
            }}
        >
            <DialogContent>
                <DialogHeader className="mb-1" closeButton={!isOnboardingPath}>
                    <DialogTitle className="text-left">
                        {t("title")}
                    </DialogTitle>
                </DialogHeader>
                <DialogDescription className="text-muted-foreground">
                    {t("description", { suffix: descriptionSuffix })}
                </DialogDescription>
                <div className="flex flex-col gap-3 mt-2">
                    <Button
                        className="w-full"
                        onClick={() => {
                            onCreateTreasury();
                        }}
                    >
                        {t("createCta")}
                    </Button>
                    {showDisconnectWallet && (
                        <Button
                            variant="secondary"
                            className="w-full"
                            onClick={async () => {
                                trackClick("disconnect_wallet");
                                await onDisconnectWallet?.();
                            }}
                        >
                            {tSignIn("disconnectWallet")}
                        </Button>
                    )}
                    {isOnboardingPath ? (
                        <Button
                            variant="secondary"
                            className="w-full"
                            asChild
                            onClick={() => trackClick("view_demo")}
                        >
                            <Link href={APP_ACTIVE_TREASURY}>
                                {t("viewDemo")}
                            </Link>
                        </Button>
                    ) : (
                        <Button
                            variant="secondary"
                            className="w-full"
                            onClick={() => {
                                trackClick("keep_exploring");
                                onOpenChange(false);
                            }}
                        >
                            {t("keepExploring")}
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

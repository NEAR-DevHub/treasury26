"use client";

import { Send } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import QRCode from "react-qr-code";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { formatDepositAddress } from "./deposit-format-address";

interface DepositAddressCardProps {
    address: string;
    memo?: string | null;
    /** When true, prefer plain (unhighlighted) address formatting. */
    preferPlainAddress?: boolean;
    /** "actions" = Copy/Share buttons; "inline" = copy icon next to address. */
    copyMode?: "actions" | "inline";
    showShare?: boolean;
    onShare?: () => void;
    footer?: ReactNode;
    className?: string;
}

export function DepositAddressCard({
    address,
    memo,
    preferPlainAddress = false,
    copyMode = "actions",
    showShare = true,
    onShare,
    footer,
    className,
}: DepositAddressCardProps) {
    const t = useTranslations("depositModal");

    return (
        <div className={cn("rounded-xl overflow-hidden bg-muted", className)}>
            <div className="bg-muted p-1">
                <div className="bg-card p-2 rounded-xl space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="shrink-0 size-22 flex items-center justify-center overflow-hidden">
                            {address ? (
                                <QRCode value={address} size={88} />
                            ) : null}
                        </div>
                        <div className="flex-1 min-w-0 space-y-1 pt-1">
                            <p className="text-xs text-muted-foreground">
                                {t("addressLabel")}
                            </p>
                            <div className="flex items-start gap-2">
                                <code className="font-mono break-all text-sm sm:text-lg block">
                                    {formatDepositAddress(
                                        address,
                                        preferPlainAddress,
                                    )}
                                </code>
                                {copyMode === "inline" && (
                                    <CopyButton
                                        text={address}
                                        toastMessage={t("addressCopied")}
                                        variant="unstyled"
                                        size="icon-sm"
                                        className="shrink-0"
                                        iconClassName="w-5 h-5 text-muted-foreground"
                                    />
                                )}
                            </div>
                        </div>
                    </div>

                    {memo && (
                        <div className="space-y-1 border-t border-border pt-2">
                            <p className="text-xs text-muted-foreground">
                                {t("memoLabel")}
                            </p>
                            <div className="flex items-start justify-between gap-2">
                                <code className="font-mono break-all text-xs sm:text-sm">
                                    {memo}
                                </code>
                                <CopyButton
                                    text={memo}
                                    toastMessage={t("memoCopied")}
                                    variant="unstyled"
                                    size="icon-sm"
                                    className="shrink-0"
                                    iconClassName="w-5 h-5 text-muted-foreground"
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {copyMode === "actions" && (
                <div className="flex gap-2 p-2">
                    <CopyButton
                        text={address}
                        toastMessage={t("addressCopied")}
                        variant="secondary"
                        className="rounded-lg justify-center gap-2 bg-card hover:bg-card/90"
                    >
                        {t("copy")}
                    </CopyButton>
                    {showShare && (
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={onShare}
                            className="rounded-lg gap-2 bg-card hover:bg-card/90"
                            data-testid="deposit-share-button"
                        >
                            <Send className="size-4" />
                            {t("share")}
                        </Button>
                    )}
                </div>
            )}

            {footer}
        </div>
    );
}

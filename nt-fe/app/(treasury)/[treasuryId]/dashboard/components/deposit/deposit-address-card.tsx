"use client";
import { Icon } from "@/components/icon";
import { Sent02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import QRCode from "react-qr-code";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { formatDepositAddress } from "./deposit-format-address";

const QR_SIZE_PX = 88; // 5.5rem

interface DepositAddressCardProps {
    address: string;
    memo?: string | null;
    /**
     * Skip middle-highlight formatting. True for sputnik-dao treasury account
     * addresses (reusable confidential path); hex/one-time addresses stay highlighted.
     */
    preferPlainAddress?: boolean;
    /** "actions" = Copy/Share buttons; "inline" = copy icon next to address. */
    copyMode?: "actions" | "inline";
    showShare?: boolean;
    onShare?: () => void;
    footer?: ReactNode;
    className?: string;
}

function AddressBody({
    address,
    memo,
    preferPlainAddress,
    copyMode,
}: {
    address: string;
    memo?: string | null;
    preferPlainAddress: boolean;
    copyMode: "actions" | "inline";
}) {
    const t = useTranslations("depositModal");

    return (
        <>
            <div className="flex flex-col items-center gap-3 pt-2 md:flex-row md:items-center md:pt-0">
                <div className="size-22 shrink-0 flex items-center justify-center overflow-hidden">
                    {address ? (
                        <QRCode
                            value={address}
                            size={QR_SIZE_PX}
                            className="size-22"
                        />
                    ) : null}
                </div>
                <div className="w-full md:flex-1 min-w-0 space-y-1 md:pt-1">
                    <p className="text-sm font-medium leading-normal text-general-muted-foreground">
                        {t("addressLabel")}
                    </p>
                    <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 break-all font-sans text-lg font-semibold leading-6 text-general-foreground">
                            {formatDepositAddress(address, preferPlainAddress)}
                        </p>
                        {copyMode === "inline" && (
                            <CopyButton
                                text={address}
                                variant="unstyled"
                                size="icon-sm"
                                className="pt-0.5 pl-0.5 size-8 shrink-0 rounded-md bg-general-secondary text-general-secondary-foreground hover:bg-general-secondary/80"
                                iconClassName="size-4"
                            />
                        )}
                    </div>
                </div>
            </div>

            {memo && (
                <div className="space-y-1 border-t border-general-border pt-2">
                    <p className="text-sm font-medium leading-normal text-general-muted-foreground">
                        {t("memoLabel")}
                    </p>
                    <div className="flex items-start gap-2">
                        <code className="break-all text-sm font-semibold leading-snug text-foreground min-w-0 flex-1">
                            {memo}
                        </code>
                        <CopyButton
                            text={memo}
                            variant="unstyled"
                            size="icon-sm"
                            className="shrink-0"
                            iconClassName="w-5 h-5 text-muted-foreground"
                        />
                    </div>
                </div>
            )}
        </>
    );
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
    const showActionBar = copyMode === "actions";
    const useOuterShell = showActionBar || Boolean(footer);

    if (!useOuterShell) {
        return (
            <div
                className={cn(
                    "space-y-3 rounded-2xl border border-general-border bg-card p-3",
                    className,
                )}
            >
                <AddressBody
                    address={address}
                    memo={memo}
                    preferPlainAddress={preferPlainAddress}
                    copyMode={copyMode}
                />
            </div>
        );
    }

    return (
        <div
            className={cn(
                "rounded-2xl border border-general-border bg-general-unofficial-ghost p-1",
                className,
            )}
        >
            <div className="space-y-3 rounded-xl border border-general-border bg-card p-2">
                <AddressBody
                    address={address}
                    memo={memo}
                    preferPlainAddress={preferPlainAddress}
                    copyMode={copyMode}
                />
            </div>

            {showActionBar && (
                <div className="flex items-center justify-start gap-4 px-2 py-2">
                    <CopyButton
                        text={address}
                        variant="unstyled"
                        className="h-auto justify-start gap-2 rounded-lg px-1 py-2 text-sm font-bold leading-3.5 text-general-unofficial-ghost-foreground hover:bg-transparent"
                    >
                        {t("copy")}
                    </CopyButton>
                    {showShare && (
                        <Button
                            type="button"
                            variant="unstyled"
                            onClick={onShare}
                            className="h-auto justify-start gap-2 rounded-lg px-1 py-2 text-sm font-bold leading-3.5 text-general-unofficial-ghost-foreground hover:bg-transparent"
                            data-testid="deposit-share-button"
                        >
                            <Icon icon={Sent02Icon} />
                            {t("share")}
                        </Button>
                    )}
                </div>
            )}

            {footer}
        </div>
    );
}

"use client";

import { ChevronDown, FileText, Loader2, LogIn, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Button } from "@/components/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/constants/config";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { Address } from "./address";
import { CopyButton } from "./copy-button";
import { User } from "./user";

/**
 * Shared row styling for every entry in the account menu (header bar + sidebar
 * profile menu). `cursor-pointer` is explicit because rows render as bare
 * `<button>`s, which Tailwind's preflight leaves at the default arrow.
 *
 * `has-[>svg]:px-3` restates the padding for the rows rendered through `Button`
 * (copy address, language): its cva ships `has-[>svg]:px-4`, which `twMerge`
 * keeps alongside a plain `px-3` and then wins on specificity — leaving those
 * rows' icons 4px further in than everyone else's.
 *
 * The radius is the popover's own (`rounded-2xl`, 16px) less its `p-1.5`, so a
 * highlighted row sits concentrically inside the menu.
 */
export const accountMenuItemClass =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 has-[>svg]:px-3 text-sm font-medium transition-colors hover:bg-general-unofficial-ghost-hover";

/** Routes to `/login`, preserving where the user came from. */
export function useConnectWallet() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isConnecting, setIsConnecting] = useState(false);

    const connect = useCallback(() => {
        setIsConnecting(true);
        try {
            const params = new URLSearchParams();
            const currentQuery = searchParams.toString();
            const returnTo = currentQuery
                ? `${pathname}?${currentQuery}`
                : pathname;
            params.set("returnTo", returnTo);
            router.push(`/login?${params.toString()}`);
        } finally {
            setIsConnecting(false);
        }
    }, [pathname, router, searchParams]);

    return { connect, isConnecting };
}

/**
 * The account menu's own entries — address, copy, legal links, disconnect.
 * Extracted so the sidebar profile menu can render them alongside its extra
 * items (language, theme, help).
 */
export function AccountMenuItems({
    accountId,
    onNavigate,
    showAddress = true,
}: {
    accountId: string;
    onNavigate?: () => void;
    showAddress?: boolean;
}) {
    const t = useTranslations("signIn");
    const tAddress = useTranslations("address");
    const { disconnect } = useNear();

    return (
        <>
            {showAddress && (
                <div className="px-3 py-2">
                    <Address address={accountId} />
                </div>
            )}
            <CopyButton
                text={accountId}
                toastMessage={tAddress("copied")}
                variant="ghost"
                className={cn(accountMenuItemClass, "h-auto justify-start")}
            >
                {t("copyAddress")}
            </CopyButton>
            <Link
                href={TERMS_OF_SERVICE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={accountMenuItemClass}
                onClick={onNavigate}
            >
                <FileText className="size-4" />
                {t("termsOfService")}
            </Link>
            <Link
                href={PRIVACY_POLICY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={accountMenuItemClass}
                onClick={onNavigate}
            >
                <FileText className="size-4" />
                {t("privacyPolicy")}
            </Link>
            <div className="-mx-1.5 mt-1 border-t border-border px-1.5 pt-1 dark:border-general-border">
                <button
                    type="button"
                    className={accountMenuItemClass}
                    onClick={() => {
                        disconnect();
                        onNavigate?.();
                    }}
                >
                    <LogOut className="size-4" />
                    {t("disconnect")}
                </button>
            </div>
        </>
    );
}

/** Wallet connect CTA, shown wherever there is no authenticated account. */
export function ConnectWalletButton({
    className,
    iconOnly = false,
}: {
    className?: string;
    iconOnly?: boolean;
}) {
    const t = useTranslations("signIn");
    const tCommon = useTranslations("common");
    const { connect, isConnecting } = useConnectWallet();
    const label = `${t("connect")} ${t("wallet")}`;

    if (iconOnly) {
        return (
            <Button
                onClick={connect}
                disabled={isConnecting}
                size="icon"
                className={className}
                aria-label={label}
            >
                {isConnecting ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : (
                    <LogIn className="size-4" />
                )}
            </Button>
        );
    }

    return (
        <Button
            onClick={connect}
            disabled={isConnecting}
            className={cn("items-center gap-2", className)}
        >
            {isConnecting ? (
                <>
                    <Loader2 className="size-4 animate-spin" />
                    {tCommon("connecting")}
                </>
            ) : (
                <>
                    <LogIn className="size-4" />
                    {t("connect")}{" "}
                    <span className="hidden md:inline">{t("wallet")}</span>
                </>
            )}
        </Button>
    );
}

export function SignIn() {
    const tCommon = useTranslations("common");
    const {
        accountId: signedAccountId,
        isInitializing,
        isAuthenticated,
    } = useNear();
    const [isOpen, setIsOpen] = useState(false);

    if (isInitializing) {
        return (
            <>
                <Button
                    disabled
                    size="icon"
                    className="md:hidden"
                    aria-label={tCommon("loading")}
                >
                    <Loader2 className="size-4 animate-spin" />
                </Button>
                <Button disabled className="hidden md:flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    {tCommon("loading")}
                </Button>
            </>
        );
    }

    // Show connect button if not connected or not authenticated
    if (!signedAccountId || !isAuthenticated) {
        return (
            <>
                <ConnectWalletButton iconOnly className="md:hidden" />
                <ConnectWalletButton className="hidden md:flex" />
            </>
        );
    }

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 hover:bg-muted"
                >
                    <div className="hidden md:block max-w-[180px] min-w-0">
                        <User
                            accountId={signedAccountId}
                            withLink={false}
                            size="md"
                            truncatePrimaryAddress
                        />
                    </div>
                    <div className="flex md:hidden">
                        <User
                            accountId={signedAccountId}
                            withLink={false}
                            size="sm"
                            variant="avatar"
                        />
                    </div>
                    <ChevronDown className="hidden size-4 text-muted-foreground sm:inline" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 rounded-2xl p-1.5">
                <AccountMenuItems
                    accountId={signedAccountId}
                    onNavigate={() => setIsOpen(false)}
                />
            </PopoverContent>
        </Popover>
    );
}

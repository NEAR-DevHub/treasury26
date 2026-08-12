"use client";

import {
    ChevronDown,
    FileText,
    Loader2,
    LogIn,
    LogOut,
    UserRound,
} from "lucide-react";
import Link from "next/link";
import {
    useParams,
    usePathname,
    useRouter,
    useSearchParams,
} from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/constants/config";
import { useNear } from "@/stores/near-store";
import { CopyButton } from "./copy-button";
import { User } from "./user";

export function SignIn() {
    const t = useTranslations("signIn");
    const tCommon = useTranslations("common");
    const tAddress = useTranslations("address");
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const params = useParams();
    const treasuryId = params?.treasuryId as string | undefined;
    const {
        accountId: signedAccountId,
        isInitializing,
        isAuthenticated,
        disconnect,
    } = useNear();
    const [isOpen, setIsOpen] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const connectWalletLabel = `${t("connect")} ${t("wallet")}`;
    const accountHref = treasuryId ? `/${treasuryId}/account` : null;

    const handleConnect = async () => {
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
    };

    if (isInitializing) {
        return (
            <>
                <Button
                    disabled
                    size="icon"
                    className="md:hidden"
                    aria-label={tCommon("loading")}
                >
                    <Loader2 className="h-4 w-4 animate-spin" />
                </Button>
                <Button disabled className="hidden md:flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {tCommon("loading")}
                </Button>
            </>
        );
    }

    // Show connect button if not connected or not authenticated
    if (!signedAccountId || !isAuthenticated) {
        return (
            <>
                <Button
                    onClick={handleConnect}
                    disabled={isConnecting}
                    size="icon"
                    className="md:hidden"
                    aria-label={connectWalletLabel}
                >
                    {isConnecting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <LogIn className="h-4 w-4" />
                    )}
                </Button>
                <Button
                    onClick={handleConnect}
                    disabled={isConnecting}
                    className="hidden md:flex items-center gap-2"
                >
                    {isConnecting ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {tCommon("connecting")}
                        </>
                    ) : (
                        <>
                            <LogIn className="h-4 w-4" />
                            {t("connect")}{" "}
                            <span className="hidden md:inline">
                                {t("wallet")}
                            </span>
                        </>
                    )}
                </Button>
            </>
        );
    }

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <button className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-muted cursor-pointer">
                    <div className="hidden md:block max-w-[180px] min-w-0">
                        <User
                            accountId={signedAccountId}
                            withLink={false}
                            size="md"
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
                    <ChevronDown className="h-4 w-4 text-muted-foreground hidden sm:inline" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-1">
                <div className="flex items-center gap-2 px-2 py-2 min-w-0">
                    <div className="min-w-0 flex-1 overflow-hidden">
                        <User
                            accountId={signedAccountId}
                            withLink={false}
                            size="md"
                        />
                    </div>
                    <CopyButton
                        text={signedAccountId}
                        toastMessage={tAddress("copied")}
                        variant="ghost"
                        size="icon"
                        aria-label={t("copyAddress")}
                        className="size-8 shrink-0 text-muted-foreground hover:text-foreground hover:bg-general-unofficial-ghost-hover"
                        iconClassName="h-4 w-4"
                    />
                </div>
                <div className="border-t border-border dark:border-general-border my-1" />
                {accountHref && (
                    <Link
                        href={accountHref}
                        className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm transition-colors hover:bg-general-unofficial-ghost-hover"
                        onClick={() => setIsOpen(false)}
                    >
                        <UserRound className="h-4 w-4" />
                        {t("myAccount")}
                    </Link>
                )}
                <Link
                    href={TERMS_OF_SERVICE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm transition-colors hover:bg-general-unofficial-ghost-hover"
                    onClick={() => setIsOpen(false)}
                >
                    <FileText className="h-4 w-4" />
                    {t("termsOfService")}
                </Link>
                <Link
                    href={PRIVACY_POLICY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm transition-colors hover:bg-general-unofficial-ghost-hover"
                    onClick={() => setIsOpen(false)}
                >
                    <FileText className="h-4 w-4" />
                    {t("privacyPolicy")}
                </Link>
                <div className="border-t border-border dark:border-general-border my-1">
                    <button
                        className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm w-full transition-colors hover:bg-general-unofficial-ghost-hover"
                        onClick={() => {
                            disconnect();
                            setIsOpen(false);
                        }}
                    >
                        <LogOut className="h-4 w-4" />
                        {t("disconnect")}
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

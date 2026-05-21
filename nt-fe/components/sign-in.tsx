"use client";

import { ChevronDown, FileText, Loader2, LogIn, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
import { Address } from "./address";
import { User } from "./user";

export function SignIn() {
    const t = useTranslations("signIn");
    const tCommon = useTranslations("common");
    const router = useRouter();
    const pathname = usePathname();
    const {
        accountId: signedAccountId,
        isInitializing,
        isAuthenticated,
        disconnect,
    } = useNear();
    const [isOpen, setIsOpen] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const connectWalletLabel = `${t("connect")} ${t("wallet")}`;

    const handleConnect = async () => {
        setIsConnecting(true);
        try {
            const params = new URLSearchParams();
            params.set("returnTo", pathname);
            params.set("context", "within_treasury");
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
                    <div className="hidden md:block">
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
                            iconOnly
                        />
                    </div>
                    <ChevronDown className="h-4 w-4 text-muted-foreground hidden sm:inline" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-1">
                <div className="px-3 py-2">
                    <Address address={signedAccountId} />
                </div>
                <Link
                    href={TERMS_OF_SERVICE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors"
                    onClick={() => setIsOpen(false)}
                >
                    <FileText className="h-4 w-4" />
                    {t("termsOfService")}
                </Link>
                <Link
                    href={PRIVACY_POLICY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors"
                    onClick={() => setIsOpen(false)}
                >
                    <FileText className="h-4 w-4" />
                    {t("privacyPolicy")}
                </Link>
                <div className="border-t border-border dark:border-general-border">
                    <button
                        className="flex items-center rounded-6 gap-2 px-3 py-2 text-sm w-full hover:bg-muted transition-colors"
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

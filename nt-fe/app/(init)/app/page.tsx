"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useUserTreasuries } from "@/hooks/use-treasury-queries";
import { Button } from "@/components/button";
import { GradFlow } from "gradflow";
import Image from "next/image";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useTreasury } from "@/hooks/use-treasury";
import Logo from "@/components/logo";

function GradientTitle() {
    return (
        <p
            className="text-[30px] lg:text-5xl tracking-[-1%] leading-[28px] lg:leading-[48px] text-center lg:text-left w-full h-fit font-medium text-white backdrop-blur-[10px] mix-blend-overlay"
            style={{
                WebkitMask: "linear-gradient(#000 0 0) text",
                mask: "linear-gradient(#000 0 0) text",
            }}
        >
            Cross-chain multisig security for managing digital assets
        </p>
    );
}

export default function AppRedirect() {
    const router = useRouter();
    const {
        accountId,
        connect,
        isInitializing,
        isAuthenticating,
        authError,
        clearError,
    } = useNear();
    const {
        data: treasuries = [],
        isLoading,
        isError,
    } = useUserTreasuries(accountId);
    const { lastTreasuryId } = useTreasury();

    useEffect(() => {
        if (!isLoading && treasuries.length > 0) {
            router.push(`/${lastTreasuryId || treasuries[0].daoId}`);
        } else if (
            accountId &&
            treasuries.length === 0 &&
            !isLoading &&
            !isError &&
            !isInitializing
        ) {
            router.push(`/app/new`);
        }
    }, [treasuries, isLoading, router]);
    const buttonText = isInitializing
        ? "Loading..."
        : isAuthenticating || isLoading
          ? "Authenticating..."
          : "Connect Wallet";

    return (
        <div className="relative h-screen w-full overflow-hidden">
            <GradFlow
                config={{
                    color1: { r: 0, g: 67, b: 224 },
                    color2: { r: 255, g: 255, b: 255 },
                    color3: { r: 9, g: 83, b: 255 },
                    speed: 0.4,
                    scale: 1,
                    type: "stripe",
                    noise: 0.08,
                }}
                className="absolute inset-0"
            />
            <div className="flex relative w-full h-full items-center justify-between overflow-hidden">
                <div className="w-full lg:w-2/5 h-full p-2 lg:p-4 flex flex-col justify-center min-w-0">
                    <div className="w-full min-h-[30%] flex items-center lg:hidden">
                        <GradientTitle />
                    </div>
                    <div className="w-full gap-12 flex flex-col p-4 items-center h-full justify-center bg-white rounded-2xl lg:max-w-4xl">
                        <Logo size="lg" />
                        <div className="flex w-full flex-col items-center justify-center gap-6 ">
                            <div className="flex w-full flex-col gap-2 text-center">
                                <h1 className="text-2xl font-semibold">
                                    Welcome to your Treasury
                                </h1>
                                <p className="text-sm text-muted-foreground font-medium">
                                    Use your wallet to sign in into your
                                    treasury.
                                </p>
                            </div>
                            <div className="flex flex-col w-full px-4 lg:px-16 px gap-3 items-center justify-center">
                                <Button
                                    size="default"
                                    className="w-full max-w-md"
                                    onClick={() => {
                                        if (authError) clearError();
                                        connect();
                                    }}
                                    disabled={
                                        isAuthenticating || isInitializing
                                    }
                                >
                                    {(isAuthenticating || isInitializing) && (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    )}
                                    {buttonText}
                                </Button>
                                <p className="text-center text-sm">
                                    Don't have a wallet?{" "}
                                    <Link
                                        href="https://wallet.near.org"
                                        className="hover:underline"
                                        target="_blank"
                                    >
                                        Create one
                                    </Link>
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="hidden lg:flex w-3/5 h-full pt-12 pb-7 pl-16 flex-col gap-9">
                    <div className="w-full pr-[72px]">
                        <GradientTitle />
                    </div>
                    <div className="w-full h-fit rounded-[16px] rounded-r-none">
                        <Image
                            src="/welcome.svg"
                            loading="eager"
                            alt="welcome"
                            width={0}
                            height={0}
                            className="h-full rounded-l-[16px] w-auto min-w-[calc(100%+200px)]"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

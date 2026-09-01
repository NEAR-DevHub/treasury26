"use client";

import { useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/hooks/use-treasury";
import { DepositModal } from "../components/deposit-modal";

export default function DepositPage() {
    const t = useTranslations("depositModal");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const searchParams = useSearchParams();
    const initialPrefillRef = useRef({
        token: searchParams.get("token") ?? undefined,
        network: searchParams.get("network") ?? undefined,
    });

    const handleHeaderBack = useCallback(() => {
        if (treasuryId) {
            router.push(`/${treasuryId}/dashboard`);
            return;
        }
        router.back();
    }, [router, treasuryId]);

    return (
        <PageComponentLayout
            title={t("title")}
            backButton={handleHeaderBack}
            hideMobileShellControls
            hideHeaderOnMobile
        >
            <div className="flex justify-center w-full">
                <div className="flex w-full max-w-xl min-w-72 flex-1 flex-col gap-7 lg:gap-4">
                    <div className="mt-3 flex items-center gap-2 lg:hidden">
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={handleHeaderBack}
                            className="size-10 shrink-0 rounded-xl bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={t("back")}
                        >
                            <Icon icon={ArrowLeft01Icon} className="stroke-2" />
                        </Button>
                        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-general-foreground">
                            {t("title")}
                        </h1>
                    </div>
                    <DepositModal
                        key={treasuryId ?? "deposit"}
                        prefillTokenId={initialPrefillRef.current.token}
                        prefillNetworkId={initialPrefillRef.current.network}
                    />
                </div>
            </div>
        </PageComponentLayout>
    );
}

"use client";

import { useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
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
        >
            <div className="flex justify-center w-full">
                <div className="flex w-full max-w-[588px] min-w-[300px] flex-1 flex-col gap-7 lg:gap-4">
                    <h1 className="mt-3 text-xl font-semibold leading-[1.2] tracking-tight lg:hidden">
                        {t("title")}
                    </h1>
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

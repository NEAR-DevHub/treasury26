"use client";

import { useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/hooks/use-treasury";
import { DepositModal } from "../components/deposit-modal";

export default function DepositPage() {
    const t = useTranslations("depositModal");
    const { treasuryId } = useTreasury();
    const searchParams = useSearchParams();
    const initialPrefillRef = useRef({
        token: searchParams.get("token") ?? undefined,
        network: searchParams.get("network") ?? undefined,
    });

    return (
        <PageComponentLayout
            title={t("title")}
            backButton={treasuryId ? `/${treasuryId}/dashboard` : true}
            backKind="section"
            hideMobileShellControls
        >
            <div className="flex justify-center w-full">
                <div className="flex w-full max-w-xl min-w-72 flex-1 flex-col gap-7 lg:gap-4">
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

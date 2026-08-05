"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useTreasury } from "@/hooks/use-treasury";
import { DepositModal } from "../components/deposit-modal";

export default function DepositPage() {
    const tDashboard = useTranslations("pages.dashboard");
    const { treasuryId } = useTreasury();
    const searchParams = useSearchParams();
    const initialPrefillRef = useRef({
        token: searchParams.get("token") ?? undefined,
        network: searchParams.get("network") ?? undefined,
    });

    return (
        <PageComponentLayout
            title={tDashboard("title")}
            description={tDashboard("description")}
        >
            <div className="flex justify-center w-full">
                <div className="flex-1 max-w-[600px] w-full min-w-[300px]">
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

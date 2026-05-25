"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { PageComponentLayout } from "@/components/page-component-layout";
import { DepositModal } from "../components/deposit-modal";
import { DepositFaq } from "../components/deposit-faq";

export default function DepositPage() {
    const tDashboard = useTranslations("pages.dashboard");
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
            <div className="flex flex-wrap justify-center gap-4 w-full">
                <div className="flex-1 max-w-[600px] w-full min-w-[300px]">
                    <DepositModal
                        prefillTokenId={initialPrefillRef.current.token}
                        prefillNetworkId={initialPrefillRef.current.network}
                    />
                </div>
                <div className="flex flex-col max-w-[300px] w-full shrink-0">
                    <DepositFaq />
                </div>
            </div>
        </PageComponentLayout>
    );
}

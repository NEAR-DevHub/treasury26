"use client";

import { use } from "react";
import { PageComponentLayout } from "@/components/page-component-layout";
import { ExpandedView } from "@/features/proposals";
import { useProposal } from "@/hooks/use-proposals";
import { useTreasuryPolicy, useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";

interface RequestPageProps {
    params: Promise<{
        id: string;
    }>;
}

export default function RequestPage({ params }: RequestPageProps) {
    const { id } = use(params);
    const { selectedTreasury } = useTreasury();
    const { data: proposal, isLoading: isLoadingProposal, error: errorProposal } = useProposal(selectedTreasury, id);
    const { data: policy, isLoading: isLoadingPolicy, error: errorPolicy } = useTreasuryPolicy(selectedTreasury);
    const { data: config, isLoading: isLoadingConfig } = useTreasuryConfig(selectedTreasury);

    if (isLoadingProposal || isLoadingPolicy || isLoadingConfig) {
        return <div>Loading...</div>;
    }

    if (errorProposal || errorPolicy) {
        return <div>Error loading proposal or policy</div>;
    }

    return (
        <PageComponentLayout title={`Request #${proposal?.id}`} description="Details for Request" backButton={`/${selectedTreasury}/requests`}>
            <ExpandedView proposal={proposal!} policy={policy!} config={config?.config} hideOpenInNewTab />
        </PageComponentLayout>
    );
}

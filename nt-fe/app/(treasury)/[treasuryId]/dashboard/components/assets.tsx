import { AssetsTable } from "@/components/assets-table";
import { TreasuryAsset } from "@/lib/api";
import { PageCard } from "@/components/card";
import { AssetsTableSkeleton } from "@/components/assets-table";
import { Coins } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

interface Props {
    tokens: TreasuryAsset[];
    isLoading?: boolean;
}

export default function Assets({ tokens, isLoading }: Props) {
    const renderContent = () => {
        if (isLoading) {
            return <AssetsTableSkeleton />;
        }

        if (tokens.length === 0) {
            return (
                <EmptyState
                    icon={Coins}
                    title="No assets yet"
                    description="To get started, add assets to your Treasury by making a deposit."
                />
            );
        }

        return <AssetsTable tokens={tokens} />;
    };

    return (
        <PageCard className="flex flex-col gap-5">
            <h2 className="font-semibold">Assets</h2>
            {renderContent()}
        </PageCard>
    );
}

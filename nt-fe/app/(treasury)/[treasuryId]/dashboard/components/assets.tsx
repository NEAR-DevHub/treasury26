import { AssetsTable } from "@/components/assets-table";
import { TreasuryAsset } from "@/lib/api";
import { PageCard } from "@/components/card";
import { AssetsTableSkeleton } from "@/components/assets-table";
import { Coins } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { StepperHeader } from "@/components/step-wizard";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useMemo, useState } from "react";
import { useAggregatedTokens } from "@/hooks/use-assets";

interface Props {
    tokens: TreasuryAsset[];
    isLoading?: boolean;
}

export default function Assets({ tokens, isLoading }: Props) {
    const aggregatedTokens = useAggregatedTokens(tokens);
    const [filterLessThanDollar, setFilterLessThanDollar] = useState(false);

    const total = useMemo(
        () =>
            aggregatedTokens.reduce(
                (value, element) => value + element.totalBalanceUSD,
                0,
            ),
        [aggregatedTokens],
    );

    const isThereSomethingToHide = useMemo(
        () => aggregatedTokens.some((value) => value.totalBalanceUSD < 1),
        [aggregatedTokens],
    );

    const shouldWeHide = total > 1 && isThereSomethingToHide;

    useEffect(() => {
        if (shouldWeHide) {
            setFilterLessThanDollar(true);
        }
    }, [isLoading, aggregatedTokens]);

    const filteredAssets = useMemo(
        () =>
            filterLessThanDollar
                ? aggregatedTokens.filter((value) => value.totalBalanceUSD > 1)
                : aggregatedTokens,
        [aggregatedTokens, filterLessThanDollar],
    );

    const renderContent = () => {
        if (isLoading) {
            return <AssetsTableSkeleton />;
        }

        if (filteredAssets.length === 0) {
            return (
                <EmptyState
                    icon={Coins}
                    title="No assets yet"
                    description="To get started, add assets to your Treasury by making a deposit."
                />
            );
        }

        return <AssetsTable aggregatedTokens={filteredAssets} />;
    };

    return (
        <PageCard className="flex flex-col gap-5">
            <div className="flex justify-between">
                <StepperHeader title="Assets" />
                {shouldWeHide && (
                    <div className="flex gap-2">
                        <Checkbox
                            checked={filterLessThanDollar}
                            onCheckedChange={(value) =>
                                setFilterLessThanDollar(value as boolean)
                            }
                            defaultChecked={total > 1}
                        />
                        <p className="text-xs text-muted-foreground">
                            {"Hide assets <1 USD"}
                        </p>
                    </div>
                )}
            </div>
            {renderContent()}
        </PageCard>
    );
}

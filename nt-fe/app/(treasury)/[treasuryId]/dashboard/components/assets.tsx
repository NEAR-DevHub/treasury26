import { AssetsTable } from "@/components/assets-table";
import { TreasuryAsset } from "@/lib/api";
import { PageCard } from "@/components/card";
import { AssetsTableSkeleton } from "@/components/assets-table";

interface Props {
    tokens: TreasuryAsset[];
    isLoading?: boolean;
}

export default function Assets({ tokens, isLoading }: Props) {
    console.log("isLoading", isLoading);

    return (
        <PageCard className="flex flex-col gap-5">
            <h2 className="font-semibold">Assets</h2>
            {isLoading ? <AssetsTableSkeleton /> : <AssetsTable tokens={tokens} />}
        </PageCard>
    )
}

import { AssetsTable } from "@/components/assets-table";
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { TreasuryAsset } from "@/lib/api";
import { PageCard } from "@/components/card";

interface Props {
    tokens: TreasuryAsset[];
}

export default function Assets({ tokens }: Props) {

    return (
        <PageCard className="flex flex-col gap-5">
            <h2 className="font-semibold">Assets</h2>
            <AssetsTable tokens={tokens} />
        </PageCard>
    )
}

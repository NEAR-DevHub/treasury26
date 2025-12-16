import { AssetsTable } from "@/components/assets-table";
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { TreasuryAsset } from "@/lib/api";
import { PageCard } from "@/components/card";

interface Props {
    tokens: TreasuryAsset[];
}

export default function Assets({ tokens }: Props) {

    return (
        <PageCard>
            <Tabs>
                <TabsList>
                    <TabsTrigger value="assets">Assets</TabsTrigger>
                </TabsList>
                <TabsContents>
                    <TabsContent value="assets">
                        <AssetsTable tokens={tokens} />
                    </TabsContent>
                </TabsContents>
            </Tabs>
        </PageCard>
    )
}

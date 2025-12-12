import { TreasuryAsset } from "@/lib/api";
import { useState, useMemo } from "react";
import BalanceChart from "./chart";
import { Button } from "@/components/ui/button";
import { ArrowLeftRight, ArrowUpRightIcon, Database, Download } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useTokenBalanceHistory } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { subscribeWithSelector } from "zustand/middleware";
import { PageCard } from "@/components/card";
import { formatBalance } from "@/lib/utils";

interface Props {
    totalBalanceUSD: number;
    tokens: TreasuryAsset[];
}

type TimePeriod = "1H" | "1D" | "1W" | "1M" | "1Y" | "All";

const TIME_PERIODS: TimePeriod[] = ["1D", "1W", "1M", "1Y"];

export default function BalanceWithGraph({ totalBalanceUSD, tokens }: Props) {
    const { selectedTreasury: accountId } = useTreasury();
    const [selectedToken, setSelectedToken] = useState<string>("all");
    const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>("1W");

    const selectedTokenData = selectedToken === "all" ? null : tokens.find(token => token.symbol === selectedToken);
    const balance = selectedTokenData ? selectedTokenData.balanceUSD : totalBalanceUSD;

    // Determine which token ID to fetch history for
    const tokenIdForHistory = selectedToken === "all" ? "near" : (selectedTokenData?.id || null);

    // Fetch balance history for the selected token
    const { data: balanceHistory, isLoading } = useTokenBalanceHistory(accountId, tokenIdForHistory);

    // Transform balance history data for the chart
    const chartData = useMemo(() => {
        if (!balanceHistory || !balanceHistory[selectedPeriod]) {
            return [];
        }

        return balanceHistory[selectedPeriod].map((entry) => ({
            name: entry.date,
            value: parseFloat(formatBalance(entry.balance, entry.decimals)),
        }));
    }, [balanceHistory, selectedPeriod]);

    return (
        <PageCard>
            <div className="flex justify-around gap-4 mb-6">
                <div className="flex-1">
                    <h3 className="text-xs font-medium text-muted-foreground">Total Balance</h3>
                    <p className="text-3xl font-bold mt-2">${balance.toFixed(2)}</p>
                </div>
                <div className="flex gap-2 items-center">
                    <Select value={selectedToken} onValueChange={setSelectedToken}>
                        <SelectTrigger size="sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Tokens</SelectItem>
                            {tokens.map(token => (
                                <SelectItem key={token.id} value={token.id}>{token.symbol}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <ToggleGroup type="single" size="sm" variant={"outline"} value={selectedPeriod} onValueChange={(e) => setSelectedPeriod(e as TimePeriod)}>
                        {TIME_PERIODS.map((e => <ToggleGroupItem value={e}>{e}</ToggleGroupItem>))}
                    </ToggleGroup>
                </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Button><Download className="size-4" /> Deposit</Button>
                <Button><ArrowUpRightIcon className="size-4" /> Send</Button>
                <Button><ArrowLeftRight className="size-4" /> Exchange</Button>
                <Button><Database className="size-4" /> Earn</Button>
            </div>
            <BalanceChart data={chartData} />
        </PageCard>
    )
}

"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/modal";
import { Button } from "@/components/button";
import { DateRangePicker } from "@/components/date-range-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Coins } from "lucide-react";
import { useTreasury } from "@/hooks/use-treasury";
import { useAssets, useAggregatedTokens } from "@/hooks/use-assets";
import { cn } from "@/lib/utils";

interface ExportActivityModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type DocumentType = "csv" | "json" | "xlsx";

const DOCUMENT_TYPES: { value: DocumentType; label: string }[] = [
  { value: "csv", label: ".CSV" },
  { value: "json", label: ".JSON" },
  { value: "xlsx", label: ".XLSX" },
];

interface DateRange {
  from: Date;
  to: Date | undefined;
}

export function ExportActivityModal({ isOpen, onClose }: ExportActivityModalProps) {
  const { treasuryId } = useTreasury();
  const { data } = useAssets(treasuryId, { onlyPositiveBalance: false });
  const aggregatedTokens = useAggregatedTokens(data?.tokens || []);

  const [documentType, setDocumentType] = useState<DocumentType>("csv");
  const [dateRange, setDateRange] = useState<DateRange>({
    from: new Date(new Date().setMonth(new Date().getMonth() - 1)),
    to: new Date(),
  });
  const [selectedAsset, setSelectedAsset] = useState<string>("all");
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    if (!treasuryId || !dateRange.from || !dateRange.to) return;

    setIsExporting(true);
    try {
      const params = new URLSearchParams({
        account_id: treasuryId,
        start_time: dateRange.from.toISOString(),
        end_time: dateRange.to.toISOString(),
      });

      // Add token_ids if a specific asset is selected
      if (selectedAsset !== "all") {
        const selectedToken = aggregatedTokens.find(t => t.symbol === selectedAsset);
        if (selectedToken) {
          // Get all token IDs from all networks for this symbol
          const tokenIds = selectedToken.networks.map(n => n.id).join(",");
          params.append("token_ids", tokenIds);
        }
      }

      const url = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api/balance-history/${documentType}?${params.toString()}`;

      // Trigger download
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Export failed");
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      const filename = `balance_changes_${treasuryId}_${dateRange.from.toISOString().split('T')[0]}_to_${dateRange.to.toISOString().split('T')[0]}.${documentType}`;
      link.download = filename;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      onClose();
    } catch (error) {
      console.error("Export error:", error);
      alert("Failed to export data. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="border-b border-border p-4 pb-3">
          <DialogTitle>Export Recent Activity</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 p-4 pt-0">
          {/* Document Type */}
          <div>
            <label className="text-sm font-medium mb-2 block">Document Type</label>
            <div className="flex gap-2">
              {DOCUMENT_TYPES.map((type) => (
                <Button
                  key={type.value}
                  variant="unstyled"
                  onClick={() => setDocumentType(type.value)}
                  className={cn(
                    "flex-1 border",
                    documentType === type.value
                      ? "bg-secondary"
                      : ""
                  )}
                  style={{
                    borderColor: documentType === type.value
                      ? 'var(--general-unofficial-border-5)'
                      : 'var(--general-unofficial-border-3)',
                  }}
                >
                  {type.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Date Range */}
          <div>
            <label className="text-sm font-medium mb-2 block">Date Range</label>
            <DateRangePicker
              initialDateFrom={dateRange.from}
              initialDateTo={dateRange.to}
              align="start"
              locale="en-US"
              onUpdate={(values) => {
                if (values.range) {
                  setDateRange(values.range);
                }
              }}
            />
          </div>

          {/* Asset Selection */}
          <div>
            <label className="text-sm font-medium mb-2 block">Asset</label>
            <Select value={selectedAsset} onValueChange={setSelectedAsset}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select asset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <div className="flex items-center gap-2">
                    <Coins className="w-5 h-5" />
                    <span>All Assets</span>
                  </div>
                </SelectItem>
                {aggregatedTokens.map((token) => (
                  <SelectItem key={token.symbol} value={token.symbol}>
                    <div className="flex items-center gap-2">
                      {token.icon && (
                        <img src={token.icon} alt={token.symbol} className="w-5 h-5 rounded-full" />
                      )}
                      <span>{token.symbol}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Export Button */}
          <Button
            onClick={handleExport}
            disabled={!dateRange.from || !dateRange.to || isExporting}
            className="w-full mt-3"
          >
            {isExporting ? "Exporting..." : "Export"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


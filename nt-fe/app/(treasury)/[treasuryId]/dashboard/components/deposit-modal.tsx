import { useState, useEffect, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import QRCode from "react-qr-code";
import { SelectModal } from "./select-modal";
import { fetchDepositAssets, fetchDepositAddress } from "@/lib/bridge-api";
import { useTreasury } from "@/stores/treasury-store";
import { useThemeStore } from "@/stores/theme-store";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import { InputBlock } from "@/components/input-block";
import { WarningAlert } from "@/components/warning-alert";

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SelectOption {
  id: string;
  name: string;
  symbol?: string;
  icon: string;
  gradient?: string;
  networks?: NetworkOption[];
}

interface NetworkOption {
  id: string;
  name: string;
  icon: string | null;
  chainId: string;
}

const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string().optional(),
  icon: z.string(),
  gradient: z.string().optional(),
  networks: z.array(z.any()).optional(),
});

const networkSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  gradient: z.string().optional(),
});

const depositFormSchema = z.object({
  asset: assetSchema.nullable().refine((val) => val !== null, {
    message: "Please select an asset",
  }),
  network: networkSchema.nullable().refine((val) => val !== null, {
    message: "Please select a network",
  }),
});

type Asset = z.infer<typeof assetSchema>;
type Network = z.infer<typeof networkSchema>;

type DepositFormValues = {
  asset: Asset | null;
  network: Network | null;
};

export function DepositModal({ isOpen, onClose }: DepositModalProps) {
  const { selectedTreasury } = useTreasury();
  const { theme } = useThemeStore();

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(depositFormSchema),
    mode: "onChange",
    defaultValues: {
      asset: null,
      network: null,
    },
  });

  const [modalType, setModalType] = useState<"asset" | "network" | null>(null);
  const [allAssets, setAllAssets] = useState<SelectOption[]>([]);
  const [allNetworks, setAllNetworks] = useState<SelectOption[]>([]);
  const [filteredNetworks, setFilteredNetworks] = useState<SelectOption[]>([]);
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [isLoadingAddress, setIsLoadingAddress] = useState(false);
  const [assetNetworkMap, setAssetNetworkMap] = useState<Map<string, string[]>>(
    new Map()
  );

  const selectedAsset = form.watch("asset");
  const selectedNetwork = form.watch("network");

  // Fetch assets when modal opens or theme changes
  useEffect(() => {
    if (isOpen) {
      fetchAssets();
    }
  }, [isOpen, theme]);

  // Fetch all assets and networks once
  const fetchAssets = async () => {
    setIsLoadingAssets(true);
    form.clearErrors("asset");
    form.clearErrors("network");

    try {
      const assets = await fetchDepositAssets(theme);
      // Add "Other" asset that deposits directly to treasury
      const otherAsset = {
        id: "other",
        name: "Other",
        symbol: "OTHER",
        icon: "O",
        gradient: "bg-gradient-cyan-blue",
        networks: [
          {
            id: "near:mainnet",
            name: "Near",
            icon: "https://img.rhea.finance/images/NEARIcon.png",
            chainId: "near:mainnet",
          },
        ],
      };

      // Format assets
      const formattedAssets: SelectOption[] = [
        ...assets.map((asset: any) => {
          // Check if icon is a valid URL or data URI
          const hasValidIcon =
            asset.icon &&
            (asset.icon.startsWith("http") ||
              asset.icon.startsWith("data:") ||
              asset.icon.startsWith("/"));

          return {
            id: asset.id,
            name: asset.name || asset.assetName,
            symbol: asset.symbol,
            icon: hasValidIcon ? asset.icon : asset.symbol?.charAt(0) || "?",
            gradient: "bg-gradient-cyan-blue",
            networks: asset.networks,
          };
        }),
      ];

      // Add "Other" at the end
      formattedAssets.push(otherAsset);

      // Extract all unique networks
      const networkMap = new Map<string, NetworkOption>();
      const assetToNetworks = new Map<string, string[]>();

      formattedAssets.forEach((asset) => {
        const networkIds: string[] = [];

        asset.networks?.forEach((network: NetworkOption) => {
          const networkKey = network.chainId;
          networkIds.push(networkKey);

          // Add to network map
          if (!networkMap.has(networkKey)) {
            networkMap.set(networkKey, network);
          }
        });

        // Add to asset→networks map
        assetToNetworks.set(asset.id, networkIds);
      });

      // Format networks - backend already returns sorted data
      const formattedNetworks: SelectOption[] = Array.from(
        networkMap.values()
      ).map((network) => ({
        id: network.chainId,
        name: network.name,
        symbol: undefined,
        icon: network.icon || network.name.charAt(0),
        gradient: "bg-linear-to-br from-green-500 to-teal-500",
      }));

      // Set all data
      setAllAssets(formattedAssets);
      setAllNetworks(formattedNetworks);
      setAssetNetworkMap(assetToNetworks);

      // Auto-select USDT asset
      const usdtAsset = formattedAssets.find(
        (asset) =>
          asset.symbol?.toLowerCase() === "usdt" ||
          asset.name?.toLowerCase().includes("tether")
      );

      if (usdtAsset) {
        form.setValue("asset", usdtAsset);

        // Get networks for USDT
        const networkIds = assetToNetworks.get(usdtAsset.id) || [];
        const availableNetworks = formattedNetworks.filter((n) =>
          networkIds.includes(n.id)
        );
        setFilteredNetworks(availableNetworks);

        // Auto-select network if only one is available
        if (availableNetworks.length === 1) {
          form.setValue("network", availableNetworks[0]);
        }
      }
    } catch (err) {
      form.setError("asset", {
        type: "manual",
        message: "Failed to load assets. Please try again.",
      });
    } finally {
      setIsLoadingAssets(false);
    }
  };

  // Handle asset selection - show all assets but update network list
  const handleAssetSelect = useCallback(
    (asset: SelectOption) => {
      form.setValue("asset", asset);
      form.clearErrors("asset");
      form.clearErrors("network");

      setDepositAddress(null);

      // Get networks that support this asset
      const supportedNetworkIds = assetNetworkMap.get(asset.id) || [];
      const availableNetworks = allNetworks.filter((network) =>
        supportedNetworkIds.includes(network.id)
      );

      setFilteredNetworks(availableNetworks);

      // Auto-select network if only one is available
      if (availableNetworks.length === 1) {
        form.setValue("network", availableNetworks[0]);
      } else if (
        selectedNetwork &&
        !supportedNetworkIds.includes(selectedNetwork.id)
      ) {
        form.setValue("network", null);
      }
    },
    [form, assetNetworkMap, allNetworks, selectedNetwork]
  );

  // Handle network selection
  const handleNetworkSelect = useCallback(
    (network: SelectOption) => {
      form.setValue("network", network);
      form.clearErrors("network");
      form.clearErrors("asset");

      setDepositAddress(null);
    },
    [form]
  );

  // Fetch deposit address when both asset and network are selected
  useEffect(() => {
    const fetchAddress = async () => {
      if (!selectedTreasury || !selectedNetwork || !selectedAsset) {
        setDepositAddress(null);
        return;
      }

      // All NEAR networks deposit directly to treasury account ID
      const isNearNetwork = selectedNetwork.id.toLowerCase().includes("near");
      if (isNearNetwork) {
        setDepositAddress(selectedTreasury);
        return;
      }

      setIsLoadingAddress(true);
      form.clearErrors("network");

      try {
        const result = await fetchDepositAddress(
          selectedTreasury,
          selectedNetwork.id
        );

        if (result && result.address) {
          setDepositAddress(result.address);
          form.clearErrors("network");
        } else {
          setDepositAddress(null);
          form.setError("network", {
            type: "manual",
            message:
              "Could not retrieve deposit address for the selected asset and network.",
          });
        }
      } catch (err: any) {
        form.setError("network", {
          type: "manual",
          message:
            err.message || "Failed to fetch deposit address. Please try again.",
        });
        setDepositAddress(null);
      } finally {
        setIsLoadingAddress(false);
      }
    };

    if (selectedAsset && selectedNetwork && selectedTreasury) {
      fetchAddress();
    } else {
      setDepositAddress(null);
    }
  }, [selectedAsset, selectedNetwork, selectedTreasury]);

  // Reset all state when modal closes
  const handleClose = useCallback(() => {
    form.reset();
    setDepositAddress(null);
    setFilteredNetworks([]);
    setModalType(null);
    onClose();
  }, [form, onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Deposit</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <div>
            <p className="font-semibold pb-2">
              Select asset and network to see deposit address
            </p>

            {/* Asset Select */}
            <FormField
              control={form.control}
              name="asset"
              render={({ fieldState }) => (
                <FormItem>
                  <InputBlock
                    title="Asset"
                    invalid={!!fieldState.error}
                    className="rounded-b-none border-b border-gray-200"
                  >
                    <Button
                      type="button"
                      onClick={() => setModalType("asset")}
                      variant="unstyled"
                      className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0 mt-1"
                    >
                      <div className="w-full flex items-center justify-between py-1">
                        {selectedAsset ? (
                          <div className="flex items-center gap-2">
                            {selectedAsset.icon?.startsWith("http") ||
                              selectedAsset.icon?.startsWith("data:") ? (
                              <img
                                src={selectedAsset.icon}
                                alt={selectedAsset.symbol}
                                className="w-6 h-6 rounded-full object-contain"
                              />
                            ) : (
                              <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold bg-gradient-cyan-blue">
                                <span>{selectedAsset.icon}</span>
                              </div>
                            )}
                            <span className="text-foreground font-medium">
                              {selectedAsset.symbol} ({selectedAsset.name})
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-lg font-normal">
                            Select Asset
                          </span>
                        )}
                        <ChevronDown className="w-5 h-5" />
                      </div>
                    </Button>
                  </InputBlock>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Network Select */}
            <FormField
              control={form.control}
              name="network"
              render={({ fieldState }) => (
                <FormItem>
                  <InputBlock
                    title="Network"
                    invalid={!!fieldState.error}
                    className="rounded-t-none"
                  >
                    <Button
                      type="button"
                      onClick={() => setModalType("network")}
                      variant="unstyled"
                      className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0 mt-1"
                    >
                      <div className="w-full flex items-center justify-between py-1">
                        {selectedNetwork ? (
                          <div>
                            <div className="flex items-center gap-2">
                              {selectedNetwork.icon?.startsWith("http") ||
                                selectedNetwork.icon?.startsWith("data:") ? (
                                <div className="w-6 h-6 rounded-full object-cover">
                                  <img
                                    src={selectedNetwork.icon}
                                    alt={selectedNetwork.name}
                                    className="w-full h-full"
                                  />
                                </div>
                              ) : (
                                <div
                                  className={`w-6 h-6 rounded-full ${selectedNetwork.gradient ||
                                    "bg-linear-to-br from-green-500 to-teal-500"
                                    } flex items-center justify-center text-white text-xs font-bold`}
                                >
                                  <span>{selectedNetwork.icon}</span>
                                </div>
                              )}
                              <span className="text-foreground font-medium">
                                {selectedNetwork.name}
                              </span>
                            </div>
                            {/* Info message for "Other" asset */}
                            {selectedAsset?.id === "other" && (
                              <div className="break-all overflow-wrap-anywhere text-wrap mt-2 text-sm text-general-info-foreground">
                                You can deposit any token not listed in the
                                assets, but only via the NEAR network.
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-lg font-normal">
                            Select Network
                          </span>
                        )}
                        <ChevronDown className="w-5 h-5" />
                      </div>
                    </Button>
                  </InputBlock>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Deposit Address Section */}
            {isLoadingAddress && (
              <div className="mt-6 space-y-4 animate-pulse">
                <div>
                  <div className="h-6 bg-muted rounded w-48 mb-2" />
                  <div className="h-4 bg-muted rounded w-72" />
                </div>

                <div className="bg-muted rounded-lg p-2">
                  <div className="flex gap-4">
                    {/* QR Code Skeleton */}
                    <div className="shrink-0">
                      <div className="w-32 h-32 bg-background rounded-lg" />
                    </div>

                    {/* Address Skeleton */}
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-background rounded w-20" />
                      <div className="bg-background rounded-lg p-3"></div>
                    </div>
                  </div>
                </div>

                {/* Warning Skeleton */}
                <div className="bg-muted rounded-lg p-3 flex gap-3">
                  <div className="w-5 h-5 bg-background rounded shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-background rounded w-full" />
                    <div className="h-4 bg-background rounded w-3/4" />
                  </div>
                </div>
              </div>
            )}

            {depositAddress && !isLoadingAddress && (
              <div className="mt-6 space-y-3">
                <div>
                  <h3 className="font-semibold mb-1">Deposit Address</h3>
                  <p className="text-sm text-muted-foreground">
                    Always double-check your deposit address.
                  </p>
                </div>

                <div className="bg-muted rounded-lg p-2">
                  <div className="flex gap-3">
                    {/* QR Code */}
                    <div className="shrink-0">
                      <div className="w-40 h-40 rounded-lg flex items-center justify-center p-2">
                        <QRCode
                          value={depositAddress}
                          size={112}
                          style={{
                            height: "auto",
                            maxWidth: "100%",
                            width: "100%",
                          }}
                        />
                      </div>
                    </div>

                    {/* Address */}
                    <div className="flex-1 space-y-2 pt-1">
                      <label className="text-sm text-muted-foreground">
                        Address
                      </label>
                      <div className="rounded-lg flex justify-between gap-2">
                        <code className="font-mono break-all">
                          {depositAddress}
                        </code>
                        <CopyButton
                          text={depositAddress}
                          toastMessage="Address copied to clipboard"
                          variant="unstyled"
                          size="icon-sm"
                          className="shrink-0"
                          iconClassName="w-5 h-5 text-muted-foreground"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Warning Message */}
                <WarningAlert
                  message={
                    <span>
                      Only deposit from the{" "}
                      <strong>{selectedNetwork?.name}</strong> network. We
                      recommend starting with a small test transaction to ensure
                      everything works correctly before sending the full amount.
                    </span>
                  }
                />
              </div>
            )}

            <SelectModal
              isOpen={modalType === "asset"}
              onClose={() => setModalType(null)}
              onSelect={(option) => {
                handleAssetSelect(option);
                setModalType(null);
              }}
              title="Select Asset"
              options={allAssets}
              searchPlaceholder="Search by name"
              isLoading={isLoadingAssets}
              selectedId={selectedAsset?.id}
            />

            <SelectModal
              isOpen={modalType === "network"}
              onClose={() => setModalType(null)}
              onSelect={(option) => {
                handleNetworkSelect(option);
                setModalType(null);
              }}
              title="Select Network"
              options={filteredNetworks}
              searchPlaceholder="Search by name"
              isLoading={isLoadingAssets}
            />
          </div>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

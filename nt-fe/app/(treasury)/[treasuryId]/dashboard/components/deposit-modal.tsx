import { useState, useEffect } from "react";
import { X, ChevronDown, Copy, AlertTriangle } from "lucide-react";
import QRCode from "react-qr-code";
import { SelectModal } from "./select-modal";
import { getAggregatedBridgeAssets, fetchDepositAddress } from "@/lib/bridge-api";
import { useTreasury } from "@/stores/treasury-store";
import { useThemeStore } from "@/stores/theme-store";

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

export function DepositModal({ isOpen, onClose }: DepositModalProps) {
  const { selectedTreasury } = useTreasury();
  const { theme } = useThemeStore();
  
  const [modalType, setModalType] = useState<"asset" | "network" | null>(null);
  const [allAssets, setAllAssets] = useState<SelectOption[]>([]);
  const [allNetworks, setAllNetworks] = useState<SelectOption[]>([]);
  const [filteredAssets, setFilteredAssets] = useState<SelectOption[]>([]);
  const [filteredNetworks, setFilteredNetworks] = useState<SelectOption[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<SelectOption | null>(null);
  const [selectedNetwork, setSelectedNetwork] = useState<SelectOption | null>(null);
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [isLoadingAddress, setIsLoadingAddress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [assetNetworkMap, setAssetNetworkMap] = useState<Map<string, string[]>>(new Map());
  const [networkAssetMap, setNetworkAssetMap] = useState<Map<string, string[]>>(new Map());

  // Fetch assets when modal opens
  useEffect(() => {
    if (isOpen && allAssets.length === 0) {
      fetchAssets();
    }
  }, [isOpen]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  // Fetch all assets and networks once
  const fetchAssets = async () => {
    setIsLoadingAssets(true);
    setError(null);
    
    try {
      const assets = await getAggregatedBridgeAssets(theme);
      
      // Format assets
      const formattedAssets: SelectOption[] = assets.map((asset: any) => ({
        id: asset.id,
        name: asset.name,
        symbol: asset.symbol,
        icon: asset.icon || asset.symbol?.charAt(0) || "?",
        gradient: "bg-linear-to-br from-blue-500 to-purple-500",
        networks: asset.networks,
      }));
      
      // Extract all unique networks
      const networkMap = new Map<string, NetworkOption>();
      const assetToNetworks = new Map<string, string[]>();
      const networkToAssets = new Map<string, string[]>();
      
      formattedAssets.forEach((asset) => {
        const networkIds: string[] = [];
        
        asset.networks?.forEach((network: NetworkOption) => {
          const networkKey = network.chainId;
          networkIds.push(networkKey);
          
          // Add to network map
          if (!networkMap.has(networkKey)) {
            networkMap.set(networkKey, network);
          }
          
          // Add to network→assets map
          if (!networkToAssets.has(networkKey)) {
            networkToAssets.set(networkKey, []);
          }
          networkToAssets.get(networkKey)?.push(asset.id);
        });
        
        // Add to asset→networks map
        assetToNetworks.set(asset.id, networkIds);
      });
      
      // Format networks
      const formattedNetworks: SelectOption[] = Array.from(networkMap.values()).map((network) => ({
        id: network.chainId,
        name: network.name,
        symbol: undefined,
        icon: network.icon || network.name.charAt(0),
        gradient: "bg-linear-to-br from-green-500 to-teal-500",
      }));
      
      // Set all data
      setAllAssets(formattedAssets);
      setAllNetworks(formattedNetworks);
      setFilteredAssets(formattedAssets);
      setFilteredNetworks(formattedNetworks);
      setAssetNetworkMap(assetToNetworks);
      setNetworkAssetMap(networkToAssets);
      
    } catch (err) {
      setError("Failed to load assets. Please try again.");
    } finally {
      setIsLoadingAssets(false);
    }
  };

  // Handle asset selection - filter networks
  const handleAssetSelect = (asset: SelectOption) => {
    setSelectedAsset(asset);
    
    // Always reset deposit address when asset changes
    setDepositAddress(null);
    
    // Filter networks that support this asset
    const supportedNetworkIds = assetNetworkMap.get(asset.id) || [];
    const filtered = allNetworks.filter((network) => 
      supportedNetworkIds.includes(network.id)
    );
    
    setFilteredNetworks(filtered);
    
    // Reset network if it's not available for this asset
    if (selectedNetwork && !supportedNetworkIds.includes(selectedNetwork.id)) {
      setSelectedNetwork(null);
    }
  };
  
  // Handle network selection - filter assets
  const handleNetworkSelect = (network: SelectOption) => {
    setSelectedNetwork(network);
    
    // Always reset deposit address when network changes
    setDepositAddress(null);
    
    // Filter assets that support this network
    const supportedAssetIds = networkAssetMap.get(network.id) || [];
    const filtered = allAssets.filter((asset) => 
      supportedAssetIds.includes(asset.id)
    );
    
    setFilteredAssets(filtered);
    
    // Reset asset if it's not available on this network
    if (selectedAsset && !supportedAssetIds.includes(selectedAsset.id)) {
      setSelectedAsset(null);
    }
  };

  // Fetch deposit address when both asset and network are selected
  useEffect(() => {
    const fetchAddress = async () => {
      if (!selectedTreasury || !selectedNetwork || !selectedAsset) {
        setDepositAddress(null);
        return;
      }
      
      setIsLoadingAddress(true);
      setError(null);
      
      try {
        // Find the specific network entry for this asset to get the correct intents_token_id
        const assetData = allAssets.find(a => a.id === selectedAsset.id);
        const networkData = assetData?.networks?.find((n: NetworkOption) => n.chainId === selectedNetwork.id);
        
        if (!networkData) {
          setError("Network configuration not found for this asset.");
          setIsLoadingAddress(false);
          return;
        }
        
        const result = await fetchDepositAddress(selectedTreasury, networkData.chainId);
        
        if (result && result.address) {
          setDepositAddress(result.address);
        } else {
          setDepositAddress(null);
          setError("Could not retrieve deposit address for the selected asset and network.");
        }
      } catch (err: any) {
        setError(err.message || "Failed to fetch deposit address. Please try again.");
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
  }, [selectedAsset, selectedNetwork, selectedTreasury, allAssets]);

  const handleCopyAddress = () => {
    if (depositAddress) {
      navigator.clipboard.writeText(depositAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Reset all state when modal closes
  const handleClose = () => {
    setSelectedAsset(null);
    setSelectedNetwork(null);
    setDepositAddress(null);
    setFilteredAssets(allAssets);
    setFilteredNetworks(allNetworks);
    setError(null);
    setCopied(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-lg shadow-xl max-w-2xl w-full border">
        {/* Header */}
        <div className="flex items-center justify-between p-4 pb-4 border-b">
          <h2 className="text-xl font-semibold">Deposit</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 pt-4 pb-6 space-y-2">
          <p className="text-sm font-semibold">
            Select asset and network to see deposit address
          </p>

          {/* Error Message */}
          {error && (
            <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg p-3 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            </div>
          )}

          {/* Asset/Network Selection */}
          <div className="bg-muted rounded-lg p-4 space-y-2">
            {/* Asset Select */}
            <button
              type="button"
              onClick={() => setModalType("asset")}
              className="space-y-2 border-b pb-3 border-foreground/10 w-full text-left cursor-pointer hover:opacity-80 transition-opacity"
            >
              <label className="text-sm text-muted-foreground cursor-pointer">
                Asset
              </label>
              <div className="w-full flex items-center justify-between py-1 text-base">
                {selectedAsset ? (
                  <div className="flex items-center gap-2">
                    {selectedAsset.icon?.startsWith('http') || selectedAsset.icon?.startsWith('data:') ? (
                      <img 
                        src={selectedAsset.icon} 
                        alt={selectedAsset.symbol} 
                        className="w-6 h-6 rounded-full object-cover" 
                      />
                    ) : (
                      <div
                        className={`w-6 h-6 rounded-full ${
                          selectedAsset.gradient || "bg-linear-to-br from-blue-500 to-purple-500"
                        } flex items-center justify-center text-white text-xs font-bold`}
                      >
                        <span>{selectedAsset.icon}</span>
                      </div>
                    )}
                    <span className="text-foreground font-medium">
                      {selectedAsset.symbol} ({selectedAsset.name})
                    </span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Select Asset</span>
                )}
                <ChevronDown className="w-5 h-5" />
              </div>
            </button>

            {/* Network Select */}
            <button
              type="button"
              onClick={() => setModalType("network")}
              className="space-y-2 pt-1 w-full text-left cursor-pointer hover:opacity-80 transition-opacity"
            >
              <label className="text-sm text-muted-foreground cursor-pointer">
                Network
              </label>
              <div className="w-full flex items-center justify-between py-1 text-base">
                {selectedNetwork ? (
                  <div className="flex items-center gap-2">
                    {selectedNetwork.icon?.startsWith('http') || selectedNetwork.icon?.startsWith('data:') ? (
                      <img 
                        src={selectedNetwork.icon} 
                        alt={selectedNetwork.name} 
                        className="w-6 h-6 rounded-full object-cover" 
                      />
                    ) : (
                      <div
                        className={`w-6 h-6 rounded-full ${
                          selectedNetwork.gradient || "bg-linear-to-br from-green-500 to-teal-500"
                        } flex items-center justify-center text-white text-xs font-bold`}
                      >
                        <span>{selectedNetwork.icon}</span>
                      </div>
                    )}
                    <span className="text-foreground font-medium">{selectedNetwork.name}</span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Select Network</span>
                )}
                <ChevronDown className="w-5 h-5" />
              </div>
            </button>
          </div>

          {/* Deposit Address Section */}
          {isLoadingAddress && (
            <div className="mt-6 space-y-4 animate-pulse">
              <div>
                <div className="h-6 bg-muted rounded w-48 mb-2" />
                <div className="h-4 bg-muted rounded w-72" />
              </div>

              <div className="bg-muted rounded-lg p-4">
                <div className="flex gap-4">
                  {/* QR Code Skeleton */}
                  <div className="shrink-0">
                    <div className="w-32 h-32 bg-background rounded-lg" />
                  </div>

                  {/* Address Skeleton */}
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-background rounded w-20" />
                    <div className="bg-background rounded-lg p-3">
                      <div className="h-4 bg-muted rounded w-full" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Warning Skeleton */}
              <div className="bg-muted rounded-lg p-4 flex gap-3">
                <div className="w-5 h-5 bg-background rounded shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-background rounded w-full" />
                  <div className="h-4 bg-background rounded w-3/4" />
                </div>
              </div>
            </div>
          )}
          
          {depositAddress && !isLoadingAddress && (
            <div className="mt-6 space-y-4">
              <div>
                <h3 className="text-lg font-semibold mb-1">Deposit Address</h3>
                <p className="text-sm text-muted-foreground">
                  Always double-check your deposit address.
                </p>
              </div>

              <div className="bg-muted rounded-lg p-4">
                <div className="flex gap-4">
                  {/* QR Code */}
                  <div className="shrink-0">
                    <div className="w-32 h-32 rounded-lg bg-white flex items-center justify-center p-2">
                      <QRCode
                        value={depositAddress}
                        size={112}
                        style={{ height: "auto", maxWidth: "100%", width: "100%" }}
                      />
                    </div>
                  </div>

                  {/* Address */}
                  <div className="flex-1 space-y-2">
                    <label className="text-sm text-muted-foreground">
                      Address
                    </label>
                    <div className="rounded-lg flex justify-between gap-2 pt-1">
                      <code className="font-mono break-all">{depositAddress}</code>
                      <button
                        type="button"
                        onClick={handleCopyAddress}
                        className="shrink-0 px-2 hover:bg-muted rounded transition-colors"
                        title="Copy address"
                      >
                        {copied ? (
                          <span className="text-lg text-green-600 dark:text-green-400">✓</span>
                        ) : (
                          <Copy className="w-5 h-5 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Warning Message */}
              <div className="bg-yellow-50 dark:bg-yellow-950/50 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 flex gap-3">
                <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  Only deposit from the {selectedNetwork?.name} network. We recommend starting
                  with a small test transaction to ensure everything works correctly before
                  sending the full amount.
                </p>
              </div>
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
            options={filteredAssets}
            searchPlaceholder="Search by name"
            isLoading={isLoadingAssets}
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
      </div>
    </div>
  );
}


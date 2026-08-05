"use client";

import { useTranslations } from "next-intl";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { AggregatedAsset } from "@/hooks/use-assets";
import { TreasuryAsset } from "@/lib/api";
import { formatBalance, formatCurrency } from "@/lib/utils";
import { availableBalance, lockedBalance } from "@/lib/balance";
import Big from "@/lib/big";
import { NetworkDisplay, BalanceCell } from "./token-display";
import { AuthButton } from "./auth-button";
import { Button } from "./button";
import { VestingDetailsModal } from "./vesting-details-modal";
import { EarningDetailsModal } from "./earning-details-modal";
import { Tooltip } from "./tooltip";
import { useTreasury } from "@/hooks/use-treasury";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buildPaymentsDeepLinkForAsset } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-transfer-url";
import { buildTokenQueryParam } from "@/lib/token-query-param";
import {
    ArrowUpRight,
    ArrowLeftRight,
    ChevronRight,
    Lock,
    Info,
} from "lucide-react";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    asset: AggregatedAsset | null;
}

const calculateBalanceUSD = (balance: Big, price: number, decimals: number) => {
    return balance.div(Big(10).pow(decimals)).mul(price).toNumber();
};

export function AssetDetailsModal({ isOpen, onClose, asset }: Props) {
    const t = useTranslations("assetDetails");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const [selectedVestingNetwork, setSelectedVestingNetwork] =
        useState<TreasuryAsset | null>(null);
    const [isVestingModalOpen, setIsVestingModalOpen] = useState(false);
    const [selectedStakingNetwork, setSelectedStakingNetwork] =
        useState<TreasuryAsset | null>(null);
    const [isStakingModalOpen, setIsStakingModalOpen] = useState(false);

    if (!asset) return null;

    const sourceNetworks = asset.networks.filter(
        (n) => n.residency !== "Lockup" && n.residency !== "Staked",
    );
    const stakingNetworks = asset.networks.filter(
        (n) => n.residency === "Staked",
    );
    const vestingNetworks = asset.networks.filter(
        (n) => n.residency === "Lockup",
    );

    const vestingNetwork = vestingNetworks[0];
    const vestedPercent =
        vestingNetwork?.balance.type === "Vested" &&
        vestingNetwork.balance.lockup.totalAllocated.gt(0)
            ? vestingNetwork.balance.lockup.totalAllocated
                  .sub(vestingNetwork.balance.lockup.unvested)
                  .div(vestingNetwork.balance.lockup.totalAllocated)
                  .mul(100)
                  .toNumber()
            : 0;

    const isSubModalOpen = isVestingModalOpen || isStakingModalOpen;

    return (
        <>
            <Dialog
                open={isOpen && !isSubModalOpen}
                onOpenChange={(open) => !open && onClose()}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{asset.name}</DialogTitle>
                    </DialogHeader>

                    <div className="flex flex-col">
                        {/* Coin Price */}
                        <div className="flex items-center pb-3 gap-3 border-b border-border/50">
                            <span className="flex-1 text-sm text-muted-foreground">
                                {t("coinPrice")}
                            </span>
                            <span className="text-sm font-medium">
                                {formatCurrency(asset.price)}
                            </span>
                        </div>

                        {/* Weight */}
                        <div className="flex items-center gap-3 py-3 border-b border-border/50">
                            <span className="flex-1 text-sm text-muted-foreground">
                                {t("weight")}
                            </span>
                            <div className="w-24 bg-muted rounded-full h-1.5 overflow-hidden shrink-0">
                                <div
                                    className="bg-foreground h-full rounded-full transition-all"
                                    style={{ width: `${asset.weight}%` }}
                                />
                            </div>
                            <span className="text-xs font-medium w-14 text-right shrink-0">
                                {asset.weight.toFixed(2)}%
                            </span>
                        </div>

                        {/* SOURCE Section */}
                        {sourceNetworks.length > 0 && (
                            <>
                                <div className="pt-3 pb-1.5">
                                    <span className="text-xxs font-medium uppercase text-muted-foreground">
                                        {t("source")}
                                    </span>
                                </div>
                                {sourceNetworks.map((network, idx) => {
                                    const available = availableBalance(
                                        network.balance,
                                    );
                                    const locked = lockedBalance(
                                        network.balance,
                                    );
                                    const tokenParam =
                                        buildTokenQueryParam(network);
                                    const paymentsPath =
                                        buildPaymentsDeepLinkForAsset(
                                            treasuryId!,
                                            {
                                                assetId: asset.id,
                                                networkId:
                                                    network.contractId ??
                                                    network.id,
                                                networkName: network.network,
                                                residency: network.residency,
                                            },
                                        );
                                    return (
                                        <div
                                            key={idx}
                                            className="flex items-center gap-2 py-3 border-b border-border/50"
                                        >
                                            <div className="flex-1 min-w-0">
                                                <NetworkDisplay
                                                    asset={network}
                                                />
                                            </div>
                                            <div className="text-right shrink-0">
                                                <BalanceCell
                                                    balance={Big(
                                                        formatBalance(
                                                            available,
                                                            network.decimals,
                                                            network.decimals,
                                                        ),
                                                    )}
                                                    symbol={network.symbol}
                                                    balanceUSD={calculateBalanceUSD(
                                                        available,
                                                        network.price,
                                                        network.decimals,
                                                    )}
                                                />
                                            </div>
                                            <div className="flex gap-1 shrink-0">
                                                <AuthButton
                                                    permissionKind="transfer"
                                                    permissionAction="AddProposal"
                                                    variant="ghost"
                                                    size="icon"
                                                    tooltipContent={t("send")}
                                                    onClick={() => {
                                                        onClose();
                                                        router.push(
                                                            paymentsPath,
                                                        );
                                                    }}
                                                >
                                                    <ArrowUpRight className="size-4 text-primary" />
                                                </AuthButton>
                                                <AuthButton
                                                    permissionKind="call"
                                                    permissionAction="AddProposal"
                                                    variant="ghost"
                                                    size="icon"
                                                    tooltipContent={t(
                                                        "exchange",
                                                    )}
                                                    onClick={() => {
                                                        onClose();
                                                        router.push(
                                                            `/${treasuryId}/exchange?sellToken=${tokenParam}`,
                                                        );
                                                    }}
                                                >
                                                    <ArrowLeftRight className="size-4 text-primary" />
                                                </AuthButton>
                                            </div>
                                        </div>
                                    );
                                })}
                            </>
                        )}

                        {/* STAKING Section */}
                        {stakingNetworks.length > 0 && (
                            <>
                                {stakingNetworks.map((network, idx) => {
                                    const available = availableBalance(
                                        network.balance,
                                    );
                                    return (
                                        <div
                                            key={idx}
                                            className="flex items-center gap-2 py-3 border-b border-border/50 cursor-pointer"
                                            onClick={() => {
                                                setSelectedStakingNetwork(
                                                    network,
                                                );
                                                setIsStakingModalOpen(true);
                                            }}
                                        >
                                            <div className="flex-1 min-w-0">
                                                <NetworkDisplay
                                                    asset={network}
                                                />
                                            </div>
                                            <div className="text-right shrink-0">
                                                <BalanceCell
                                                    balance={Big(
                                                        formatBalance(
                                                            available,
                                                            network.decimals,
                                                            network.decimals,
                                                        ),
                                                    )}
                                                    symbol={network.symbol}
                                                    balanceUSD={calculateBalanceUSD(
                                                        available,
                                                        network.price,
                                                        network.decimals,
                                                    )}
                                                />
                                            </div>
                                            <div className="flex gap-1 shrink-0">
                                                <div className="size-9" />
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelectedStakingNetwork(
                                                            network,
                                                        );
                                                        setIsStakingModalOpen(
                                                            true,
                                                        );
                                                    }}
                                                >
                                                    <ChevronRight className="size-4 text-primary" />
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </>
                        )}

                        {/* VESTING Section */}
                        {vestingNetworks.length > 0 && (
                            <>
                                {/* Vesting header */}
                                <div className="flex items-center justify-between pt-3 pb-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-xxs font-medium uppercase text-muted-foreground">
                                            {t("vesting")}
                                        </span>
                                        <Lock className="size-3 text-muted-foreground shrink-0" />
                                    </div>
                                    {vestingNetwork?.balance.type ===
                                        "Vested" && (
                                        <div className="flex items-center gap-2">
                                            <div className="w-20 bg-muted rounded-full h-1.5 overflow-hidden">
                                                <div
                                                    className="bg-primary h-full rounded-full transition-all"
                                                    style={{
                                                        width: `${vestedPercent}%`,
                                                    }}
                                                />
                                            </div>
                                            <span className="text-xxs text-muted-foreground whitespace-nowrap">
                                                {t("vestedPercent", {
                                                    percent:
                                                        vestedPercent.toFixed(
                                                            0,
                                                        ),
                                                })}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {vestingNetworks.map((network, idx) => {
                                    const available = availableBalance(
                                        network.balance,
                                    );
                                    const locked = lockedBalance(
                                        network.balance,
                                    );
                                    return (
                                        <div key={idx}>
                                            {/* Network row */}
                                            <div
                                                className="flex items-center gap-2 py-3 border-b border-border/50 cursor-pointer"
                                                onClick={() => {
                                                    setSelectedVestingNetwork(
                                                        network,
                                                    );
                                                    setIsVestingModalOpen(true);
                                                }}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <NetworkDisplay
                                                        asset={network}
                                                    />
                                                </div>
                                                <div className="text-right shrink-0">
                                                    <BalanceCell
                                                        balance={Big(
                                                            formatBalance(
                                                                available,
                                                                network.decimals,
                                                                network.decimals,
                                                            ),
                                                        )}
                                                        symbol={network.symbol}
                                                        balanceUSD={calculateBalanceUSD(
                                                            available,
                                                            network.price,
                                                            network.decimals,
                                                        )}
                                                    />
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled
                                                        tooltipContent={t(
                                                            "comingSoon",
                                                        )}
                                                        onClick={(e) =>
                                                            e.stopPropagation()
                                                        }
                                                    >
                                                        <ArrowUpRight className="size-4 text-primary" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSelectedVestingNetwork(
                                                                network,
                                                            );
                                                            setIsVestingModalOpen(
                                                                true,
                                                            );
                                                        }}
                                                    >
                                                        <ChevronRight className="size-4 text-primary" />
                                                    </Button>
                                                </div>
                                            </div>

                                            {/* Frozen row */}
                                            {locked.gt(0) && (
                                                <div className="flex items-center gap-3 py-3 border-b border-border/50">
                                                    <div className="flex-1 flex items-center gap-1 text-sm text-muted-foreground">
                                                        {t("frozen")}
                                                        <Tooltip
                                                            content={t(
                                                                "frozenTooltip",
                                                            )}
                                                        >
                                                            <Info className="size-3 shrink-0" />
                                                        </Tooltip>
                                                    </div>
                                                    <div className="text-right shrink-0">
                                                        <BalanceCell
                                                            balance={Big(
                                                                formatBalance(
                                                                    locked,
                                                                    network.decimals,
                                                                    network.decimals,
                                                                ),
                                                            )}
                                                            symbol={
                                                                network.symbol
                                                            }
                                                            balanceUSD={calculateBalanceUSD(
                                                                locked,
                                                                network.price,
                                                                network.decimals,
                                                            )}
                                                        />
                                                    </div>
                                                </div>
                                            )}

                                            {/* Vested row */}
                                            {network.balance.type ===
                                                "Vested" && (
                                                <div className="flex items-center gap-3 py-3">
                                                    <span className="flex-1 text-sm text-muted-foreground">
                                                        {t("vested")}
                                                    </span>
                                                    <span className="text-sm font-medium">
                                                        {formatBalance(
                                                            network.balance.lockup.totalAllocated.sub(
                                                                network.balance
                                                                    .lockup
                                                                    .unvested,
                                                            ),
                                                            network.decimals,
                                                        )}
                                                        /
                                                        {formatBalance(
                                                            network.balance
                                                                .lockup
                                                                .totalAllocated,
                                                            network.decimals,
                                                        )}{" "}
                                                        {network.symbol}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            <VestingDetailsModal
                isOpen={isVestingModalOpen}
                onClose={() => {
                    setIsVestingModalOpen(false);
                    setSelectedVestingNetwork(null);
                }}
                asset={selectedVestingNetwork}
                treasuryId={treasuryId ?? null}
            />
            <EarningDetailsModal
                isOpen={isStakingModalOpen}
                onClose={() => {
                    setIsStakingModalOpen(false);
                    setSelectedStakingNetwork(null);
                }}
                asset={selectedStakingNetwork}
            />
        </>
    );
}

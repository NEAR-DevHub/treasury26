"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Button } from "@/components/button";
import { InputBlock } from "@/components/input-block";
import { getNetworkDisplayName } from "@/components/token-display";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { getNetworkDisplayCaseClass } from "@/lib/intents-network";
import { cn } from "@/lib/utils";
import { DepositOptionIcon } from "./deposit-option-icon";

type DepositAssetNetworkFormValues = {
    asset: {
        id: string;
        name: string;
        icon: string;
        gradient?: string;
        networks?: unknown[];
    } | null;
    network: {
        id: string;
        name: string;
        description?: string;
        symbol?: string;
        icon: string;
        gradient?: string;
        chainId?: string;
    } | null;
};

export function DepositAssetNetworkForm({
    form,
    selectedAsset,
    selectedNetwork,
    selectorsDisabled,
    isAssetsPending,
    showTopBorder = false,
    onOpenAssetModal,
    onOpenNetworkModal,
    tokenWarning = null,
    networkWarning = null,
}: {
    form: UseFormReturn<DepositAssetNetworkFormValues>;
    selectedAsset: DepositAssetNetworkFormValues["asset"];
    selectedNetwork: DepositAssetNetworkFormValues["network"];
    selectorsDisabled: boolean;
    isAssetsPending: boolean;
    /** Top border separates this form from public/confidential source cards. */
    showTopBorder?: boolean;
    onOpenAssetModal: () => void;
    onOpenNetworkModal: () => void;
    /** Inline token-paused copy under the asset row (inside the muted card). */
    tokenWarning?: ReactNode;
    /** Inline network-paused copy under the network row (inside the muted card). */
    networkWarning?: ReactNode;
}) {
    const t = useTranslations("depositModal");

    return (
        <>
            <div
                className={cn(
                    showTopBorder && "border-t border-general-border pt-3",
                )}
            >
                <p className="text-sm font-semibold">{t("subtitle")}</p>
            </div>
            <Form {...form}>
                <div className="rounded-xl bg-muted overflow-hidden divide-y divide-general-border">
                    <FormField
                        control={form.control}
                        name="asset"
                        render={({ fieldState }) => (
                            <FormItem>
                                <InputBlock
                                    title={t("assetLabel")}
                                    invalid={!!fieldState.error}
                                    className="rounded-none border-0 bg-transparent"
                                >
                                    <Button
                                        type="button"
                                        onClick={onOpenAssetModal}
                                        variant="unstyled"
                                        disabled={
                                            selectorsDisabled ||
                                            (isAssetsPending && !selectedAsset)
                                        }
                                        data-testid="deposit-asset-selector"
                                        className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                    >
                                        <div className="w-full flex items-center justify-between py-1">
                                            {isAssetsPending &&
                                            !selectedAsset ? (
                                                <div className="flex items-center gap-2">
                                                    <Skeleton className="size-6 rounded-full shrink-0" />
                                                    <Skeleton className="h-5 w-24" />
                                                </div>
                                            ) : selectedAsset ? (
                                                <div className="flex items-center gap-2">
                                                    <DepositOptionIcon
                                                        icon={
                                                            selectedAsset.icon
                                                        }
                                                        name={
                                                            selectedAsset.name
                                                        }
                                                        gradient={
                                                            selectedAsset.gradient
                                                        }
                                                    />
                                                    <span className="text-foreground font-medium capitalize">
                                                        {selectedAsset.name}
                                                    </span>
                                                </div>
                                            ) : (
                                                <span className="text-muted-foreground text-lg font-normal">
                                                    {t("selectAsset")}
                                                </span>
                                            )}
                                            <ChevronDown className="w-5 h-5" />
                                        </div>
                                    </Button>
                                    {fieldState.error ? <FormMessage /> : null}
                                    {tokenWarning ? (
                                        <div className="mt-2">
                                            {tokenWarning}
                                        </div>
                                    ) : null}
                                </InputBlock>
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="network"
                        render={({ fieldState }) => (
                            <FormItem>
                                <InputBlock
                                    title={t("networkLabel")}
                                    invalid={!!fieldState.error}
                                    className="rounded-none border-0 bg-transparent"
                                >
                                    <Button
                                        type="button"
                                        onClick={onOpenNetworkModal}
                                        variant="unstyled"
                                        disabled={selectorsDisabled}
                                        data-testid="deposit-network-selector"
                                        className="w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0! mt-1"
                                    >
                                        <div className="w-full flex flex-col gap-0 py-1">
                                            {selectedNetwork ? (
                                                <>
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-2">
                                                            <DepositOptionIcon
                                                                icon={
                                                                    selectedNetwork.icon
                                                                }
                                                                name={
                                                                    selectedNetwork.name
                                                                }
                                                                gradient={
                                                                    selectedNetwork.gradient ||
                                                                    "bg-linear-to-br from-green-500 to-teal-500"
                                                                }
                                                            />
                                                            <div className="flex flex-col">
                                                                <span
                                                                    className={cn(
                                                                        "text-foreground font-medium",
                                                                        getNetworkDisplayCaseClass(
                                                                            selectedNetwork.name,
                                                                            "uppercase",
                                                                        ),
                                                                    )}
                                                                >
                                                                    {getNetworkDisplayName(
                                                                        selectedNetwork.name,
                                                                    )}
                                                                </span>
                                                                {selectedNetwork.description && (
                                                                    <span className="text-xs text-muted-foreground font-normal">
                                                                        {
                                                                            selectedNetwork.description
                                                                        }
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <ChevronDown className="w-5 h-5" />
                                                    </div>
                                                    {selectedAsset?.id ===
                                                        "other" && (
                                                        <div className="break-all overflow-wrap-anywhere text-wrap mt-2 text-xs text-general-info-foreground">
                                                            {t(
                                                                "otherNetworkInfo",
                                                            )}
                                                        </div>
                                                    )}
                                                </>
                                            ) : (
                                                <div className="flex items-center justify-between">
                                                    <span className="text-muted-foreground text-lg font-normal">
                                                        {t("selectNetwork")}
                                                    </span>
                                                    <ChevronDown className="w-5 h-5" />
                                                </div>
                                            )}
                                        </div>
                                    </Button>
                                    {fieldState.error ? <FormMessage /> : null}
                                    {networkWarning ? (
                                        <div className="mt-2">
                                            {networkWarning}
                                        </div>
                                    ) : null}
                                </InputBlock>
                            </FormItem>
                        )}
                    />
                </div>
            </Form>
        </>
    );
}

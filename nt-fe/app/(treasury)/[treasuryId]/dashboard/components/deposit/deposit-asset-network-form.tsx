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
        symbol?: string;
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

function EmptyNetworkIcon() {
    return (
        <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full border border-general-border bg-muted"
        >
            <svg
                viewBox="0 0 16 16"
                className="size-5 text-muted-foreground"
                fill="none"
                aria-hidden="true"
            >
                <circle
                    cx="8"
                    cy="8"
                    r="5.25"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeDasharray="2 2.5"
                    strokeLinecap="round"
                />
            </svg>
        </span>
    );
}

export function DepositAssetNetworkForm({
    form,
    selectedAsset,
    selectedNetwork,
    selectorsDisabled,
    isAssetsPending,
    showTopBorder = false,
    separateFields = false,
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
    /** Confidential: two independent bordered fields instead of a stacked block. */
    separateFields?: boolean;
    onOpenAssetModal: () => void;
    onOpenNetworkModal: () => void;
    /** Inline token-paused copy under the asset row (inside the muted card). */
    tokenWarning?: ReactNode;
    /** Inline network-paused copy under the network row (inside the muted card). */
    networkWarning?: ReactNode;
}) {
    const t = useTranslations("depositModal");
    const selectedAssetLabel =
        selectedAsset?.symbol || selectedAsset?.name || "";
    const assetLabel = separateFields ? t("tokenLabel") : t("assetLabel");

    return (
        <>
            <div
                className={cn(
                    showTopBorder && "border-t border-general-border pt-6",
                )}
            >
                <p className="text-xl font-semibold leading-7 tracking-[-0.03125rem] text-foreground">
                    {t("subtitle")}
                </p>
            </div>
            <Form {...form}>
                <div
                    className={
                        separateFields
                            ? "space-y-2"
                            : "overflow-hidden rounded-xl bg-muted divide-y divide-general-border"
                    }
                >
                    <FormField
                        control={form.control}
                        name="asset"
                        render={({ fieldState }) => (
                            <FormItem>
                                <InputBlock
                                    title={
                                        separateFields ? undefined : assetLabel
                                    }
                                    invalid={!!fieldState.error}
                                    className={
                                        separateFields
                                            ? "rounded-2xl border border-general-border bg-card"
                                            : "rounded-none border-0 bg-transparent"
                                    }
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
                                        className={cn(
                                            "w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0!",
                                            !separateFields && "mt-1",
                                        )}
                                    >
                                        <div className="w-full flex items-center justify-between py-1">
                                            {isAssetsPending &&
                                            !selectedAsset ? (
                                                <div className="flex items-center gap-2">
                                                    <Skeleton className="size-10 rounded-full shrink-0" />
                                                    <Skeleton className="h-5 w-24" />
                                                </div>
                                            ) : selectedAsset ? (
                                                <div className="flex items-center gap-2">
                                                    <DepositOptionIcon
                                                        icon={
                                                            selectedAsset.icon
                                                        }
                                                        name={
                                                            selectedAssetLabel
                                                        }
                                                        gradient={
                                                            selectedAsset.gradient
                                                        }
                                                        className={
                                                            separateFields
                                                                ? "size-10"
                                                                : undefined
                                                        }
                                                    />
                                                    {separateFields ? (
                                                        <div className="flex min-w-0 flex-col">
                                                            <span className="text-sm font-medium leading-[150%] text-muted-foreground">
                                                                {assetLabel}
                                                            </span>
                                                            <span className="text-base font-semibold leading-[120%] text-foreground">
                                                                {
                                                                    selectedAssetLabel
                                                                }
                                                            </span>
                                                        </div>
                                                    ) : (
                                                        <span className="text-foreground font-medium">
                                                            {selectedAssetLabel}
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-muted-foreground text-lg font-normal">
                                                    {t("selectAsset")}
                                                </span>
                                            )}
                                            <ChevronDown className="w-5 h-5 shrink-0" />
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
                                    title={
                                        separateFields
                                            ? undefined
                                            : t("networkLabel")
                                    }
                                    invalid={!!fieldState.error}
                                    className={
                                        separateFields
                                            ? "rounded-2xl border border-general-border bg-card"
                                            : "rounded-none border-0 bg-transparent"
                                    }
                                >
                                    <Button
                                        type="button"
                                        onClick={onOpenNetworkModal}
                                        variant="unstyled"
                                        disabled={selectorsDisabled}
                                        data-testid="deposit-network-selector"
                                        className={cn(
                                            "w-full text-left cursor-pointer hover:opacity-80 h-auto justify-start p-0!",
                                            !separateFields && "mt-1",
                                        )}
                                    >
                                        <div className="w-full flex flex-col gap-0 py-1">
                                            {selectedNetwork ? (
                                                <>
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="flex min-w-0 items-center gap-2">
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
                                                                className={
                                                                    separateFields
                                                                        ? "size-10"
                                                                        : undefined
                                                                }
                                                            />
                                                            {separateFields ? (
                                                                <div className="flex min-w-0 flex-col">
                                                                    <span className="text-sm font-medium leading-[150%] text-muted-foreground">
                                                                        {t(
                                                                            "networkLabel",
                                                                        )}
                                                                    </span>
                                                                    <span
                                                                        className={cn(
                                                                            "text-base font-semibold leading-[120%] text-foreground",
                                                                            getNetworkDisplayCaseClass(
                                                                                selectedNetwork.name,
                                                                            ),
                                                                        )}
                                                                    >
                                                                        {getNetworkDisplayName(
                                                                            selectedNetwork.name,
                                                                        )}
                                                                    </span>
                                                                </div>
                                                            ) : (
                                                                <div className="flex flex-col">
                                                                    <span
                                                                        className={cn(
                                                                            "text-foreground font-medium",
                                                                            getNetworkDisplayCaseClass(
                                                                                selectedNetwork.name,
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
                                                            )}
                                                        </div>
                                                        <ChevronDown className="w-5 h-5 shrink-0" />
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
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="flex items-center gap-2">
                                                        {separateFields && (
                                                            <EmptyNetworkIcon />
                                                        )}
                                                        <span className="text-base font-semibold leading-[120%] text-muted-foreground">
                                                            {t("selectNetwork")}
                                                        </span>
                                                    </span>
                                                    <ChevronDown className="w-5 h-5 shrink-0" />
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

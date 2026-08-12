import { useTranslations } from "next-intl";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { User } from "@/components/user";
import { cn, formatGas, formatNearAmount } from "@/lib/utils";
import { FunctionCallData, FunctionCallAction } from "../../types/index";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

interface FunctionCallExpandedProps {
    data: FunctionCallData;
}

function ActionArgs({ args }: { args: Record<string, any> }) {
    return (
        <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
            <code className="text-foreground/90">
                {JSON.stringify(args, null, 2)}
            </code>
        </pre>
    );
}

interface ActionDisplayProps {
    number: number;
    action: FunctionCallAction;
    expanded: boolean;
    onExpandedClick: () => void;
}

function ActionDisplay({
    number,
    action,
    expanded,
    onExpandedClick,
}: ActionDisplayProps) {
    const t = useTranslations("proposals.expanded");
    const items: InfoItem[] = [
        {
            label: t("method"),
            value: <span>{action.methodName}</span>,
        },
        {
            label: t("gas"),
            value: <span>{formatGas(action.gas)} TGas</span>,
        },
    ];

    if (action.deposit && action.deposit !== "0") {
        items.push({
            label: t("deposit"),
            value: <span>{formatNearAmount(action.deposit)}</span>,
        });
    }

    items.push({
        label: t("arguments"),
        value: null,
        afterValue: <ActionArgs args={action.args} />,
    });

    return (
        <Collapsible open={expanded} onOpenChange={onExpandedClick}>
            <CollapsibleTrigger
                className={cn(
                    "w-full flex justify-between items-center p-3 border rounded-lg",
                    expanded && "rounded-b-none",
                )}
            >
                <div className="flex gap-2 items-center">
                    <ChevronDown
                        className={cn("w-4 h-4", expanded && "rotate-180")}
                    />
                    {t("actionNumber", { number })}
                </div>
                <div className="hidden md:flex gap-3 items-baseline text-sm text-muted-foreground">
                    <span>{action.methodName}</span>
                </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <InfoDisplay
                    style="secondary"
                    className="p-3 rounded-b-lg"
                    items={items}
                />
            </CollapsibleContent>
        </Collapsible>
    );
}

export function FunctionCallExpanded({ data }: FunctionCallExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const [expanded, setExpanded] = useState<number[]>([]);

    const onExpandedChanged = (index: number) => {
        setExpanded((prev) => {
            if (prev.includes(index)) {
                return prev.filter((id) => id !== index);
            }
            return [...prev, index];
        });
    };

    const isSingle = data.actions.length === 1;

    const headerItems: InfoItem[] = [
        {
            label: t("contract"),
            value: <User accountId={data.receiver} />,
        },
    ];

    if (isSingle) {
        return (
            <InfoDisplay
                items={[
                    ...headerItems,
                    ...(() => {
                        const action = data.actions[0];
                        const items: InfoItem[] = [
                            {
                                label: t("method"),
                                value: <span>{action.methodName}</span>,
                            },
                            {
                                label: t("gas"),
                                value: (
                                    <span>{formatGas(action.gas)} TGas</span>
                                ),
                            },
                        ];
                        if (action.deposit && action.deposit !== "0") {
                            items.push({
                                label: t("deposit"),
                                value: (
                                    <span>
                                        {formatNearAmount(action.deposit)}
                                    </span>
                                ),
                            });
                        }
                        items.push({
                            label: t("arguments"),
                            value: null,
                            afterValue: <ActionArgs args={action.args} />,
                        });
                        return items;
                    })(),
                ]}
            />
        );
    }

    const totalGas = data.actions
        .reduce((sum, a) => sum + BigInt(a.gas), BigInt(0))
        .toString();
    const totalDeposit = data.actions
        .reduce((sum, a) => sum + BigInt(a.deposit || "0"), BigInt(0))
        .toString();

    const isAllExpanded = expanded.length === data.actions.length;
    const toggleAllExpanded = () => {
        if (isAllExpanded) {
            setExpanded([]);
        } else {
            setExpanded(data.actions.map((_, i) => i));
        }
    };

    const summaryItems: InfoItem[] = [
        {
            label: t("totalGas"),
            value: <span>{formatGas(totalGas)} TGas</span>,
        },
    ];

    if (totalDeposit !== "0") {
        summaryItems.push({
            label: t("totalDeposit"),
            value: <span>{formatNearAmount(totalDeposit)}</span>,
        });
    }

    const actionsItem: InfoItem = {
        label: t("actions"),
        value: (
            <div className="flex gap-3 items-baseline">
                <p className="text-sm font-medium">
                    {t("actionsCount", { count: data.actions.length })}
                </p>
                <button
                    type="button"
                    className="text-sm text-muted-foreground hover:text-foreground"
                    onClick={toggleAllExpanded}
                >
                    {isAllExpanded ? t("collapseAll") : t("expandAll")}
                </button>
            </div>
        ),
        afterValue: (
            <div className="flex flex-col gap-1">
                {data.actions.map((action, index) => (
                    <ActionDisplay
                        key={index}
                        number={index + 1}
                        action={action}
                        expanded={expanded.includes(index)}
                        onExpandedClick={() => onExpandedChanged(index)}
                    />
                ))}
            </div>
        ),
    };

    return (
        <InfoDisplay items={[...headerItems, ...summaryItems, actionsItem]} />
    );
}

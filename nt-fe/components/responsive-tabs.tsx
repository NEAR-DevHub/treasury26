"use client";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from "@/components/ui/select";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/underline-tabs";
import { cn } from "@/lib/utils";

export interface TabItem {
    value: string;
    label: React.ReactNode;
    /** Extra content rendered only in the tab trigger on desktop (e.g. badge). Hidden in select. */
    trigger?: React.ReactNode;
    /** Plain-text label override used in the mobile Select (e.g. "Pending 3"). Falls back to label. */
    selectLabel?: string;
}

interface ResponsiveTabsProps {
    tabs: TabItem[];
    value: string;
    onValueChange: (value: string) => void;
    children?: React.ReactNode;
    /** Extra content placed to the right of the tabs/select (e.g. search + filter buttons) */
    actions?: React.ReactNode;
    /** When true, hides the tabs/actions header row */
    hideHeader?: boolean;
    /**
     * `card` sits the header row inside a bordered panel; `plain` drops that
     * chrome on desktop so the tabs underline themselves and the actions align
     * to the tab baseline.
     */
    variant?: "card" | "plain";
    className?: string;

    alignSelect?: "start" | "end";
}

/**
 * On md+ screens renders standard underline Tabs.
 * On small screens replaces the tab list with a Select dropdown.
 * `actions` is always rendered beside the tabs/select.
 */
export function ResponsiveTabs({
    tabs,
    value,
    onValueChange,
    children,
    actions,
    hideHeader,
    variant = "card",
    className,
}: ResponsiveTabsProps) {
    const isPlain = variant === "plain";
    const currentTab = tabs.find((t) => t.value === value);
    const currentLabel = currentTab?.label ?? value;
    const currentTrigger = currentTab?.trigger;

    return (
        <Tabs
            value={value}
            onValueChange={onValueChange}
            className={cn("gap-0", className)}
        >
            <div
                className={cn(
                    "relative flex flex-row items-center justify-between border-b px-5 py-3.5 gap-2",
                    isPlain &&
                        "md:items-end md:gap-6 md:border-b-0 md:px-0 md:py-0",
                    hideHeader && "hidden",
                )}
            >
                {/* Mobile: Select dropdown */}
                <div className="flex md:hidden shrink-0">
                    <Select value={value} onValueChange={onValueChange}>
                        <SelectTrigger className="border-0 h-auto gap-1.5 font-medium text-sm focus:ring-0 w-auto">
                            <span className="flex items-center gap-1.5">
                                {currentLabel}
                            </span>
                        </SelectTrigger>
                        <SelectContent align="start">
                            {tabs.map((tab) => (
                                <SelectItem key={tab.value} value={tab.value}>
                                    <span className="flex items-center gap-1.5">
                                        {tab.selectLabel ?? tab.label}
                                        {tab.value !== value && tab.trigger}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Desktop: Underline tab list */}
                <div
                    className={cn(
                        "hidden md:flex",
                        isPlain ? "min-w-0 flex-1" : "w-full",
                    )}
                >
                    <TabsList className={cn(isPlain ? "gap-2" : "border-none")}>
                        {tabs.map((tab) => (
                            <TabsTrigger
                                key={tab.value}
                                value={tab.value}
                                className={cn(
                                    "flex gap-2.5",
                                    isPlain &&
                                        "px-1 pt-0.5 pb-3 md:text-lg font-semibold text-general-muted-foreground data-[state=active]:after:h-px data-[state=active]:after:bg-general-foreground",
                                )}
                            >
                                {tab.label}
                                {tab.trigger}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </div>

                {actions && (
                    <div
                        className={cn(
                            "flex justify-end gap-2 min-w-0",
                            isPlain ? "w-full md:w-auto md:shrink-0" : "w-full",
                        )}
                    >
                        {actions}
                    </div>
                )}
            </div>

            {children}
        </Tabs>
    );
}

export { TabsContent };

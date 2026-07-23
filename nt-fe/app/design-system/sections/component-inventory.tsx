"use client";

import { Info, Search } from "lucide-react";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { Address } from "@/components/address";
// --- components/*.tsx domain wrappers ---
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { FormattedDate } from "@/components/formatted-date";
import { InfoDisplay } from "@/components/info-display";
import { Input } from "@/components/input";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import {
    Dialog as ModalDialog,
    DialogContent as ModalDialogContent,
    DialogHeader as ModalDialogHeader,
    DialogTitle as ModalDialogTitle,
    DialogTrigger as ModalDialogTrigger,
} from "@/components/modal";
import { Slider } from "@/components/slider";
import { type StepProps, StepWizard } from "@/components/step-wizard";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { Textarea } from "@/components/textarea";
import {
    NetworkIconDisplay,
    TokenAmountDisplay,
} from "@/components/token-display";
import { type Token, TokenInput } from "@/components/token-input";
import { TokenSelectPopover } from "@/components/token-select-popover";
import { Tooltip } from "@/components/tooltip";
// --- ui/ primitives (Ui-prefixed to avoid colliding with the wrapper layer) ---
import {
    Alert as UiAlert,
    AlertDescription as UiAlertDescription,
    AlertTitle as UiAlertTitle,
} from "@/components/ui/alert";
import { Button as UiButton } from "@/components/ui/button";
import {
    Card as UiCard,
    CardContent as UiCardContent,
    CardHeader as UiCardHeader,
    CardTitle as UiCardTitle,
} from "@/components/ui/card";
import { Checkbox as UiCheckbox } from "@/components/ui/checkbox";
import {
    Collapsible as UiCollapsible,
    CollapsibleContent as UiCollapsibleContent,
    CollapsibleTrigger as UiCollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DatePickerPopover as UiDatePickerPopover } from "@/components/ui/datepicker";
import {
    Dialog as UiDialog,
    DialogContent as UiDialogContent,
    DialogDescription as UiDialogDescription,
    DialogHeader as UiDialogHeader,
    DialogTitle as UiDialogTitle,
    DialogTrigger as UiDialogTrigger,
} from "@/components/ui/dialog";
import {
    DropdownMenu as UiDropdownMenu,
    DropdownMenuContent as UiDropdownMenuContent,
    DropdownMenuItem as UiDropdownMenuItem,
    DropdownMenuTrigger as UiDropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input as UiInput } from "@/components/ui/input";
import { Label as UiLabel } from "@/components/ui/label";
import {
    Popover as UiPopover,
    PopoverContent as UiPopoverContent,
    PopoverTrigger as UiPopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea as UiScrollArea } from "@/components/ui/scroll-area";
import {
    Select as UiSelect,
    SelectContent as UiSelectContent,
    SelectItem as UiSelectItem,
    SelectTrigger as UiSelectTrigger,
    SelectValue as UiSelectValue,
} from "@/components/ui/select";
import { Separator as UiSeparator } from "@/components/ui/separator";
import { Skeleton as UiSkeleton } from "@/components/ui/skeleton";
import { Slider as UiSlider } from "@/components/ui/slider";
import { Switch as UiSwitch } from "@/components/ui/switch";
import {
    Table as UiTable,
    TableBody as UiTableBody,
    TableCell as UiTableCell,
    TableHead as UiTableHead,
    TableHeader as UiTableHeader,
    TableRow as UiTableRow,
} from "@/components/ui/table";
import {
    Tabs as UiTabs,
    TabsContent as UiTabsContent,
    TabsList as UiTabsList,
    TabsTrigger as UiTabsTrigger,
} from "@/components/ui/tabs";
import { Textarea as UiTextarea } from "@/components/ui/textarea";
import { Toggle as UiToggle } from "@/components/ui/toggle";
import {
    ToggleGroup as UiToggleGroup,
    ToggleGroupItem as UiToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
    Tooltip as UiTooltip,
    TooltipContent as UiTooltipContent,
    TooltipTrigger as UiTooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Tabs as UnderlineTabs,
    TabsList as UnderlineTabsList,
    TabsTrigger as UnderlineTabsTrigger,
} from "@/components/underline-tabs";
import { WarningMessage } from "@/components/warning-message";

import { primitives, wrappers } from "../data";

function ComponentCard({
    name,
    filePath,
    usageCount,
    variants,
    notes,
    sizes,
    via,
    children,
}: {
    name: string;
    filePath: string;
    usageCount: number;
    variants?: string;
    notes?: string;
    /** Live render of the size scale, shown as its own labeled row under the main variant swatches. */
    sizes?: React.ReactNode;
    /** Live render of how this primitive actually looks through its app-level wrapper. */
    via?: { label: string; children: React.ReactNode };
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-semibold text-sm">{name}</span>
                    <code className="text-[11px] font-mono text-muted-foreground truncate">
                        {filePath}
                    </code>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {usageCount} {usageCount === 1 ? "use" : "uses"}
                </span>
            </div>
            <div className="p-4 flex flex-wrap items-center gap-3 min-h-20">
                {children}
            </div>
            {sizes && (
                <div className="px-4 pb-4 flex flex-col gap-1.5 border-t border-border pt-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Sizes
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        {sizes}
                    </div>
                </div>
            )}
            {(variants || notes) && (
                <div className="px-4 pb-3 flex flex-col gap-1">
                    {variants && (
                        <p className="text-[11px] font-mono text-muted-foreground">
                            {variants}
                        </p>
                    )}
                    {notes && (
                        <p className="text-xs text-muted-foreground">{notes}</p>
                    )}
                </div>
            )}
            {via && (
                <div className="px-4 pb-4 pt-3 border-t border-border bg-muted/40 flex flex-col gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Real usage — via {via.label}
                    </span>
                    <div className="flex flex-wrap items-center gap-3">
                        {via.children}
                    </div>
                </div>
            )}
        </div>
    );
}

function findEntry(list: typeof primitives, name: string) {
    const entry = list.find((e) => e.name === name);
    if (!entry) throw new Error(`Missing data.ts entry for "${name}"`);
    return entry;
}

function DemoStep({ handleNext, handleBack }: StepProps) {
    return (
        <div className="flex flex-col gap-2 text-sm">
            <p>Step content goes here.</p>
            <div className="flex gap-2">
                {handleBack && (
                    <UiButton size="sm" variant="outline" onClick={handleBack}>
                        Back
                    </UiButton>
                )}
                {handleNext && (
                    <UiButton size="sm" onClick={handleNext}>
                        Next
                    </UiButton>
                )}
            </div>
        </div>
    );
}

interface TokenInputDemoValues {
    amount: string;
    token: Token;
}

function TokenInputDemo() {
    const form = useForm<TokenInputDemoValues>({
        defaultValues: {
            amount: "12.5",
            token: {
                address: "near",
                symbol: "NEAR",
                decimals: 24,
                name: "NEAR",
                icon: "",
                network: "near",
                balance: "50000000000000000000000000",
                price: 4.2,
            },
        },
    });

    return (
        <FormProvider {...form}>
            <TokenInput
                control={form.control}
                title="You send"
                amountName="amount"
                tokenName="token"
                tokenSelect={{ showPopularAssets: true }}
                showInsufficientBalance
            />
        </FormProvider>
    );
}

export function ComponentInventory() {
    const [wizardStep, setWizardStep] = useState(0);
    const [datepickerValue, setDatepickerValue] = useState<Date | undefined>(
        new Date(),
    );
    const [searchValue, setSearchValue] = useState("");
    const [selectedPopoverToken, setSelectedPopoverToken] = useState<{
        id: string;
        name: string;
        icon?: string;
        gradient?: string;
    } | null>(null);

    return (
        <section id="components" className="scroll-mt-20 flex flex-col gap-10">
            <div>
                <h2 className="text-2xl font-bold">Component inventory</h2>
                <p className="text-sm text-muted-foreground">
                    Live renders of the base shadcn/Radix primitives (
                    <code className="font-mono">components/ui/</code>) and the
                    highest-usage domain wrappers (
                    <code className="font-mono">components/*.tsx</code>). 158
                    additional components (feature-scoped, single-use, or
                    icon-level) aren&apos;t shown here yet — see the plan
                    backlog.
                </p>
            </div>

            {/* ---------------- Primitives ---------------- */}
            <div className="flex flex-col gap-4">
                <h3 className="text-lg font-semibold">
                    Primitives — components/ui/
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <ComponentCard {...findEntry(primitives, "Alert")}>
                        <UiAlert className="w-full">
                            <Info className="size-4" />
                            <UiAlertTitle>Heads up</UiAlertTitle>
                            <UiAlertDescription>
                                Raw shadcn Alert, default variant.
                            </UiAlertDescription>
                        </UiAlert>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Button")}
                        sizes={
                            <>
                                <UiButton size="sm">sm</UiButton>
                                <UiButton size="default">default</UiButton>
                                <UiButton size="lg">lg</UiButton>
                                <UiButton size="icon" aria-label="icon">
                                    <Info />
                                </UiButton>
                                <UiButton size="icon-sm" aria-label="icon-sm">
                                    <Info />
                                </UiButton>
                                <UiButton size="icon-lg" aria-label="icon-lg">
                                    <Info />
                                </UiButton>
                            </>
                        }
                        via={{
                            label: "components/button.tsx",
                            children: (
                                <>
                                    <Button>Default</Button>
                                    <Button variant="outline">Outline</Button>
                                    <Button variant="secondary">
                                        Secondary
                                    </Button>
                                    <Button size="sm">sm</Button>
                                    <Button size="lg">lg</Button>
                                    <Button disabled>Disabled</Button>
                                </>
                            ),
                        }}
                    >
                        <UiButton>Default</UiButton>
                        <UiButton variant="destructive">Destructive</UiButton>
                        <UiButton variant="outline">Outline</UiButton>
                        <UiButton variant="secondary">Secondary</UiButton>
                        <UiButton variant="ghost">Ghost</UiButton>
                        <UiButton variant="link">Link</UiButton>
                        <UiButton disabled>Disabled</UiButton>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Card")}
                        via={{
                            label: "components/card.tsx (PageCard)",
                            children: (
                                <PageCard className="w-full">
                                    <p className="text-sm">
                                        PageCard content — border,
                                        rounded-[14px], different padding.
                                    </p>
                                </PageCard>
                            ),
                        }}
                    >
                        <UiCard className="w-full">
                            <UiCardHeader>
                                <UiCardTitle>Card title</UiCardTitle>
                            </UiCardHeader>
                            <UiCardContent>Card content area.</UiCardContent>
                        </UiCard>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Checkbox")}>
                        <div className="flex items-center gap-2">
                            <UiCheckbox id="ds-checkbox" defaultChecked />
                            <UiLabel htmlFor="ds-checkbox">
                                Accept terms
                            </UiLabel>
                        </div>
                        <div className="flex items-center gap-2">
                            <UiCheckbox id="ds-checkbox-disabled" disabled />
                            <UiLabel htmlFor="ds-checkbox-disabled">
                                Disabled
                            </UiLabel>
                        </div>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Collapsible")}>
                        <UiCollapsible className="w-full">
                            <UiCollapsibleTrigger asChild>
                                <UiButton variant="outline" size="sm">
                                    Toggle
                                </UiButton>
                            </UiCollapsibleTrigger>
                            <UiCollapsibleContent className="pt-2 text-sm text-muted-foreground">
                                Collapsible content.
                            </UiCollapsibleContent>
                        </UiCollapsible>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(
                            primitives,
                            "DateTimePicker / DatePickerPopover",
                        )}
                    >
                        <UiDatePickerPopover
                            value={datepickerValue}
                            onChange={(d) =>
                                setDatepickerValue(d as Date | undefined)
                            }
                        />
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Dialog")}
                        via={{
                            label: "components/modal.tsx",
                            children: (
                                <ModalDialog>
                                    <ModalDialogTrigger asChild>
                                        <Button variant="outline" size="sm">
                                            Open modal
                                        </Button>
                                    </ModalDialogTrigger>
                                    <ModalDialogContent>
                                        <ModalDialogHeader>
                                            <ModalDialogTitle>
                                                Modal wrapper
                                            </ModalDialogTitle>
                                        </ModalDialogHeader>
                                        <p className="text-sm py-2">
                                            Wallet-connector interop + mobile
                                            bottom-drawer styling.
                                        </p>
                                    </ModalDialogContent>
                                </ModalDialog>
                            ),
                        }}
                    >
                        <UiDialog>
                            <UiDialogTrigger asChild>
                                <UiButton variant="outline" size="sm">
                                    Open dialog
                                </UiButton>
                            </UiDialogTrigger>
                            <UiDialogContent>
                                <UiDialogHeader>
                                    <UiDialogTitle>Raw ui/dialog</UiDialogTitle>
                                    <UiDialogDescription>
                                        This is the unstyled Radix wrapper.
                                    </UiDialogDescription>
                                </UiDialogHeader>
                            </UiDialogContent>
                        </UiDialog>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "DropdownMenu")}>
                        <UiDropdownMenu>
                            <UiDropdownMenuTrigger asChild>
                                <UiButton variant="outline" size="sm">
                                    Open menu
                                </UiButton>
                            </UiDropdownMenuTrigger>
                            <UiDropdownMenuContent>
                                <UiDropdownMenuItem>Edit</UiDropdownMenuItem>
                                <UiDropdownMenuItem>
                                    Duplicate
                                </UiDropdownMenuItem>
                                <UiDropdownMenuItem>Delete</UiDropdownMenuItem>
                            </UiDropdownMenuContent>
                        </UiDropdownMenu>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Form / FormField")}
                    >
                        <p className="text-xs text-muted-foreground">
                            react-hook-form wrapper set — needs a live form
                            context to demo meaningfully, not embedded here.
                        </p>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Input")}
                        via={{
                            label: "components/input.tsx",
                            children: (
                                <Input
                                    search
                                    placeholder="Search…"
                                    className="w-48"
                                />
                            ),
                        }}
                    >
                        <UiInput placeholder="Raw shadcn input" />
                        <UiInput placeholder="Disabled" disabled />
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Label")}>
                        <UiLabel>Field label</UiLabel>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Popover")}>
                        <UiPopover>
                            <UiPopoverTrigger asChild>
                                <UiButton variant="outline" size="sm">
                                    Open popover
                                </UiButton>
                            </UiPopoverTrigger>
                            <UiPopoverContent className="text-sm">
                                Popover content.
                            </UiPopoverContent>
                        </UiPopover>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "ScrollArea")}>
                        <UiScrollArea className="h-20 w-full rounded border border-border p-2 text-sm">
                            {Array.from(
                                { length: 20 },
                                (_, i) => `Row ${i + 1}`,
                            ).map((row) => (
                                <div key={row}>{row}</div>
                            ))}
                        </UiScrollArea>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Select")}
                        sizes={
                            <>
                                <UiSelect defaultValue="near">
                                    <UiSelectTrigger size="sm" className="w-32">
                                        <UiSelectValue />
                                    </UiSelectTrigger>
                                    <UiSelectContent>
                                        <UiSelectItem value="near">
                                            NEAR
                                        </UiSelectItem>
                                    </UiSelectContent>
                                </UiSelect>
                                <UiSelect defaultValue="near">
                                    <UiSelectTrigger
                                        size="default"
                                        className="w-32"
                                    >
                                        <UiSelectValue />
                                    </UiSelectTrigger>
                                    <UiSelectContent>
                                        <UiSelectItem value="near">
                                            NEAR
                                        </UiSelectItem>
                                    </UiSelectContent>
                                </UiSelect>
                            </>
                        }
                    >
                        <UiSelect defaultValue="near">
                            <UiSelectTrigger className="w-40">
                                <UiSelectValue />
                            </UiSelectTrigger>
                            <UiSelectContent>
                                <UiSelectItem value="near">NEAR</UiSelectItem>
                                <UiSelectItem value="eth">
                                    Ethereum
                                </UiSelectItem>
                                <UiSelectItem value="sol">Solana</UiSelectItem>
                            </UiSelectContent>
                        </UiSelect>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Separator")}>
                        <div className="w-full">
                            <p className="text-sm">Above</p>
                            <UiSeparator className="my-2" />
                            <p className="text-sm">Below</p>
                        </div>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Skeleton")}>
                        <UiSkeleton className="h-4 w-24" />
                        <UiSkeleton className="h-4 w-16" />
                        <UiSkeleton className="size-8 rounded-full" />
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Slider")}
                        via={{
                            label: "components/slider.tsx",
                            children: (
                                <Slider
                                    defaultValue={[40]}
                                    max={100}
                                    step={1}
                                    className="w-full"
                                />
                            ),
                        }}
                    >
                        <UiSlider
                            defaultValue={[40]}
                            max={100}
                            step={1}
                            className="w-full"
                        />
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Switch")}>
                        <UiSwitch defaultChecked />
                        <UiSwitch />
                        <UiSwitch disabled />
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Table")}
                        via={{
                            label: "components/table.tsx",
                            children: (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Token</TableHead>
                                            <TableHead>Balance</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        <TableRow>
                                            <TableCell>NEAR</TableCell>
                                            <TableCell>128.4</TableCell>
                                        </TableRow>
                                    </TableBody>
                                </Table>
                            ),
                        }}
                    >
                        <UiTable>
                            <UiTableHeader>
                                <UiTableRow>
                                    <UiTableHead>Token</UiTableHead>
                                    <UiTableHead>Balance</UiTableHead>
                                </UiTableRow>
                            </UiTableHeader>
                            <UiTableBody>
                                <UiTableRow>
                                    <UiTableCell>NEAR</UiTableCell>
                                    <UiTableCell>128.4</UiTableCell>
                                </UiTableRow>
                            </UiTableBody>
                        </UiTable>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Tabs")}
                        via={{
                            label: "components/underline-tabs.tsx",
                            children: (
                                <UnderlineTabs
                                    defaultValue="a"
                                    className="w-full"
                                >
                                    <UnderlineTabsList>
                                        <UnderlineTabsTrigger value="a">
                                            Overview
                                        </UnderlineTabsTrigger>
                                        <UnderlineTabsTrigger value="b">
                                            Activity
                                        </UnderlineTabsTrigger>
                                    </UnderlineTabsList>
                                </UnderlineTabs>
                            ),
                        }}
                    >
                        <UiTabs defaultValue="a" className="w-full">
                            <UiTabsList>
                                <UiTabsTrigger value="a">Tab A</UiTabsTrigger>
                                <UiTabsTrigger value="b">Tab B</UiTabsTrigger>
                            </UiTabsList>
                            <UiTabsContent value="a" className="text-sm pt-2">
                                Raw ui/tabs, unstyled.
                            </UiTabsContent>
                            <UiTabsContent value="b" className="text-sm pt-2">
                                Tab B content.
                            </UiTabsContent>
                        </UiTabs>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Textarea")}
                        via={{
                            label: "components/textarea.tsx",
                            children: (
                                <Textarea
                                    placeholder="Wrapped textarea"
                                    className="w-full"
                                />
                            ),
                        }}
                    >
                        <UiTextarea
                            placeholder="Raw shadcn textarea"
                            className="w-full"
                        />
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Toggle")}
                        sizes={
                            <>
                                <UiToggle size="sm">sm</UiToggle>
                                <UiToggle size="default">default</UiToggle>
                                <UiToggle size="lg">lg</UiToggle>
                            </>
                        }
                    >
                        <UiToggle defaultPressed>Bold</UiToggle>
                        <UiToggle variant="outline">Outline</UiToggle>
                        <UiToggle disabled>Disabled</UiToggle>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "ToggleGroup")}>
                        <UiToggleGroup type="single" defaultValue="a">
                            <UiToggleGroupItem value="a">A</UiToggleGroupItem>
                            <UiToggleGroupItem value="b">B</UiToggleGroupItem>
                            <UiToggleGroupItem value="c">C</UiToggleGroupItem>
                        </UiToggleGroup>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(primitives, "Tooltip")}
                        via={{
                            label: "components/tooltip.tsx",
                            children: (
                                <Tooltip content="Wraps ui/popover on touch, ui/tooltip on pointer devices">
                                    <Button variant="outline" size="sm">
                                        Hover / tap me
                                    </Button>
                                </Tooltip>
                            ),
                        }}
                    >
                        <UiTooltip>
                            <UiTooltipTrigger asChild>
                                <UiButton variant="outline" size="sm">
                                    Hover me
                                </UiButton>
                            </UiTooltipTrigger>
                            <UiTooltipContent>
                                Raw ui/tooltip content.
                            </UiTooltipContent>
                        </UiTooltip>
                    </ComponentCard>

                    <ComponentCard {...findEntry(primitives, "Chart")}>
                        <p className="text-xs text-muted-foreground">
                            Recharts wrapper set — needs real series data to
                            demo meaningfully, not embedded here (389 lines for
                            its single call site in the dashboard chart).
                        </p>
                    </ComponentCard>
                </div>
            </div>

            {/* ---------------- Domain wrappers ---------------- */}
            <div className="flex flex-col gap-4">
                <h3 className="text-lg font-semibold">
                    Domain wrappers — components/*.tsx
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <ComponentCard
                        {...findEntry(wrappers, "Button")}
                        sizes={
                            <>
                                <Button size="sm">sm</Button>
                                <Button size="default">default</Button>
                                <Button size="lg">lg</Button>
                                <Button size="icon-sm" aria-label="icon-sm">
                                    <Info />
                                </Button>
                            </>
                        }
                    >
                        <Button>Default</Button>
                        <Button variant="destructive">Destructive</Button>
                        <Button variant="outline">Outline</Button>
                        <Button variant="secondary">Secondary</Button>
                        <Button variant="ghost">Ghost</Button>
                        <Button variant="link">Link</Button>
                        <Button disabled>Disabled</Button>
                        <Button
                            tooltipContent="Extra tooltip integration"
                            variant="secondary"
                        >
                            With tooltip
                        </Button>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "PageCard")}>
                        <PageCard className="w-full">
                            <p className="text-sm font-medium">
                                PageCard content
                            </p>
                            <p className="text-xs text-muted-foreground">
                                bg-card, rounded-[14px], p-4 — no border/shadow
                                (unlike ui/Card).
                            </p>
                        </PageCard>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "Tooltip")}>
                        <Tooltip content="Wraps ui/popover on touch devices, ui/tooltip on pointer devices">
                            <Button variant="outline" size="sm">
                                Hover / tap me
                            </Button>
                        </Tooltip>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "Modal (Dialog)")}>
                        <ModalDialog>
                            <ModalDialogTrigger asChild>
                                <Button variant="outline" size="sm">
                                    Open modal
                                </Button>
                            </ModalDialogTrigger>
                            <ModalDialogContent>
                                <ModalDialogHeader>
                                    <ModalDialogTitle>
                                        Modal wrapper
                                    </ModalDialogTitle>
                                </ModalDialogHeader>
                                <p className="text-sm py-2">
                                    Adds wallet-connector-popup interop + mobile
                                    bottom-drawer styling on top of ui/dialog.
                                </p>
                            </ModalDialogContent>
                        </ModalDialog>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(wrappers, "PageComponentLayout")}
                        notes="Full-page header shell (sidebar toggle, back button, title, theme toggle, sign-in). Not embedded live here — pulls in feature-level ConfidentialBanner + auth/sidebar stores. See file directly."
                    >
                        <p className="text-xs text-muted-foreground">
                            Preview omitted — see notes below.
                        </p>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "StepWizard")}>
                        <div className="w-full">
                            <StepWizard
                                step={wizardStep}
                                onStepChange={setWizardStep}
                                stepTitles={["One", "Two"]}
                                steps={[
                                    { component: DemoStep },
                                    { component: DemoStep },
                                ]}
                            />
                        </div>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "FormattedDate")}>
                        <div className="flex flex-col gap-1 text-sm">
                            <FormattedDate date={new Date()} />
                            <FormattedDate date={new Date()} relative />
                        </div>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "InfoDisplay")}>
                        <InfoDisplay
                            className="w-full"
                            items={[
                                { label: "Network", value: "NEAR" },
                                {
                                    label: "Fee",
                                    value: "0.001 NEAR",
                                    info: "Gas fee estimate",
                                },
                            ]}
                        />
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "EmptyState")}>
                        <EmptyState
                            icon={Search}
                            title="No results"
                            description="Try a different search term."
                        />
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(wrappers, "WarningMessage / SlotWarning")}
                    >
                        <div className="w-full">
                            <WarningMessage
                                variant="banner"
                                message="### Scheduled maintenance\nSome features may be unavailable."
                            />
                        </div>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "Input")}>
                        <Input
                            search
                            placeholder="Search…"
                            value={searchValue}
                            onChange={(e) => setSearchValue(e.target.value)}
                            className="w-full"
                        />
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "Table")}>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Token</TableHead>
                                    <TableHead>Balance</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow>
                                    <TableCell>NEAR</TableCell>
                                    <TableCell>128.4</TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "Textarea")}>
                        <Textarea
                            placeholder="Wrapped textarea"
                            className="w-full"
                        />
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "Address")}>
                        <Address address="alice.near-treasury.near" copyable />
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(
                            wrappers,
                            "TokenAmountDisplay / NetworkIconDisplay",
                        )}
                    >
                        <div className="flex flex-col gap-3">
                            <TokenAmountDisplay symbol="NEAR" amount="12.5" />
                            <NetworkIconDisplay
                                chainIcons={null}
                                networkName="near"
                                residency="Near"
                            />
                        </div>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "CopyButton")}>
                        <CopyButton
                            text="alice.near"
                            variant="outline"
                            size="sm"
                        >
                            Copy address
                        </CopyButton>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "LargeInput")}>
                        <InputBlock invalid={false} className="w-full">
                            <LargeInput
                                borderless
                                value="12.5"
                                suffix="NEAR"
                                placeholder="0"
                                readOnly
                            />
                        </InputBlock>
                    </ComponentCard>

                    <ComponentCard {...findEntry(wrappers, "TokenInput")}>
                        <div className="w-full">
                            <TokenInputDemo />
                        </div>
                    </ComponentCard>

                    <ComponentCard
                        {...findEntry(wrappers, "TokenSelectPopover")}
                    >
                        <TokenSelectPopover
                            selectedToken={selectedPopoverToken}
                            onTokenChange={setSelectedPopoverToken}
                        />
                    </ComponentCard>
                </div>
            </div>
        </section>
    );
}

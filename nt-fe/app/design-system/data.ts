export interface ComponentEntry {
    name: string;
    filePath: string;
    usageCount: number;
    variants?: string;
    notes?: string;
}

export interface TokenInfo {
    /** What the token means / when to reach for it. */
    purpose: string;
    /** Files under app/components/features/hooks/lib referencing it via a Tailwind utility (bg-, text-, border-, etc) or var(), excluding app/design-system itself. */
    usageCount: number;
    /** First real consumer found by that grep, for grounding. */
    example?: string;
}

// Real usage counts from `grep -rl -- "<token>" --include="*.tsx" app components features hooks lib`,
// excluding app/design-system and app/globals.css. Re-run that grep to refresh if tokens change.
export const tokenInfo: Record<string, TokenInfo> = {
    // Core
    background: {
        purpose:
            "App/page background — the outermost bg color behind everything.",
        usageCount: 41,
        example: "app/telegram/layout.tsx",
    },
    foreground: {
        purpose: "Default body text color.",
        usageCount: 168,
        example: "app/not-found.tsx",
    },
    card: {
        purpose:
            "Background for Card/PageCard surfaces and other raised panels.",
        usageCount: 92,
        example: "app/not-found.tsx",
    },
    "card-foreground": {
        purpose: "Text color on card surfaces.",
        usageCount: 8,
        example: "components/role-badge.tsx",
    },
    popover: {
        purpose: "Background for popovers, dropdowns, selects, tooltips.",
        usageCount: 18,
        example:
            "app/(treasury)/[treasuryId]/settings/components/member-avatars-with-overflow.tsx",
    },
    "popover-foreground": {
        purpose: "Text color on popover surfaces.",
        usageCount: 8,
        example: "components/pill.tsx",
    },
    primary: {
        purpose:
            "Main CTA/brand action color — default Button variant, active/selected states, links.",
        usageCount: 29,
        example: "app/wallet/page.tsx",
    },
    "primary-foreground": {
        purpose: "Text/icon color on primary-colored surfaces.",
        usageCount: 8,
        example: "app/wallet/page.tsx",
    },
    secondary: {
        purpose:
            "Lower-emphasis button/surface background (secondary Button variant).",
        usageCount: 56,
        example: "app/(treasury)/[treasuryId]/custom-templates/page.tsx",
    },
    "secondary-foreground": {
        purpose: "Text color on secondary surfaces.",
        usageCount: 8,
        example:
            "app/(treasury)/[treasuryId]/payments/bulk-payment/components/bulk-payment-credits-display.tsx",
    },
    muted: {
        purpose:
            "Subdued background — disabled states, skeleton loaders, input fields, quiet panels. Most-used token in the app.",
        usageCount: 147,
        example: "app/not-found.tsx",
    },
    "muted-foreground": {
        purpose:
            "Subdued/secondary text — labels, captions, timestamps, helper text. 2nd most-used token.",
        usageCount: 134,
        example: "app/not-found.tsx",
    },
    accent: {
        purpose:
            "Hover/highlight background — menu items, ghost-button hover, selected-row highlight.",
        usageCount: 16,
        example:
            "app/(treasury)/[treasuryId]/settings/components/voting-tab.tsx",
    },
    "accent-foreground": {
        purpose: "Text color on accent-highlighted surfaces.",
        usageCount: 9,
        example: "components/modal.tsx",
    },
    destructive: {
        purpose:
            "Error/danger color — delete actions, destructive Button variant, error text/icons.",
        usageCount: 49,
        example: "app/(treasury)/app/manage-treasuries/page.tsx",
    },
    "destructive-foreground": {
        purpose: "Text/icon color on destructive-colored surfaces.",
        usageCount: 7,
        example: "components/step-icon.tsx",
    },
    border: {
        purpose: "Default border color — cards, dividers, table rows, inputs.",
        usageCount: 117,
        example: "app/wallet/page.tsx",
    },
    input: {
        purpose: "Border/background color specifically for form input fields.",
        usageCount: 87,
        example: "app/wallet/page.tsx",
    },
    ring: {
        purpose:
            "focus-visible outline color. Extremely high count because it's baked into every shared interactive primitive's className (Button, Input, Select, etc.), not hand-written per call site.",
        usageCount: 333,
        example: "app/(treasury)/[treasuryId]/treasury-layout-client.tsx",
    },

    // Status / general — an app-specific semantic layer on top of the shadcn base tokens above.
    "general-border": {
        purpose:
            'Alternate border color for "unofficial"/legacy-styled UI (predates full token migration).',
        usageCount: 8,
        example: "app/(treasury)/[treasuryId]/members/page.tsx",
    },
    "general-unofficial-border": {
        purpose:
            "Part of a parallel neutral scale (general-unofficial-*) — looks like leftovers from before the design-token migration; used for secondary borders in a few older screens.",
        usageCount: 7,
        example: "app/(treasury)/[treasuryId]/dashboard/export/page.tsx",
    },
    "general-unofficial-ghost-foreground": {
        purpose:
            "Ghost-button-style text color in the legacy unofficial scale.",
        usageCount: 2,
        example:
            "app/(treasury)/[treasuryId]/payments/bulk-payment/components/upload-data-step.tsx",
    },
    "general-unofficial-accent": {
        purpose: "Legacy-scale accent/highlight background.",
        usageCount: 2,
        example: "components/credits-quota-display.tsx",
    },
    "general-unofficial-accent-0": {
        purpose: "Legacy-scale accent variant (lighter step).",
        usageCount: 1,
        example: "features/activity/components/recent-activity-card.tsx",
    },
    "general-success-background-faded": {
        purpose:
            'Faded green background for success status pills/banners (e.g. "Executed" proposal state).',
        usageCount: 6,
        example: "features/onboarding/components/create-treasury-entry.tsx",
    },
    "general-success-foreground": {
        purpose: "Green text/icon color for success status.",
        usageCount: 13,
        example:
            "app/(treasury)/[treasuryId]/payments/components/bulk-payment-toast.tsx",
    },
    "general-destructive-background-faded": {
        purpose: "Faded red background for error/rejected/failed status.",
        usageCount: 4,
        example: "features/proposals/components/proposal-status-pill.tsx",
    },
    "general-destructive-foreground": {
        purpose:
            "Red text/icon color for error status (distinct from the core --destructive, used for status pills specifically).",
        usageCount: 7,
        example: "components/step-icon.tsx",
    },
    "general-orange-background": {
        purpose:
            "Solid orange background — used for the staging-environment badge and similar callouts.",
        usageCount: 5,
        example: "components/page-component-layout.tsx",
    },
    "general-orange-background-faded": {
        purpose: "Faded orange background variant of the above.",
        usageCount: 4,
        example: "components/page-component-layout.tsx",
    },
    "general-orange-foreground": {
        purpose:
            "Orange text/icon color — status pills in the orange family (e.g. certain proposal states).",
        usageCount: 6,
        example: "features/proposals/components/proposal-status-pill.tsx",
    },
    "general-info-background-faded": {
        purpose: "Faded blue background for informational alerts/pills.",
        usageCount: 5,
        example:
            "app/(treasury)/[treasuryId]/payments/bulk-payment/components/upload-data-step.tsx",
    },
    "general-info-border": {
        purpose: "Border color for info-styled alerts.",
        usageCount: 2,
        example: "components/credits-quota-display.tsx",
    },
    "general-info-foreground": {
        purpose: "Blue text/icon color for informational status.",
        usageCount: 11,
        example:
            "app/(treasury)/[treasuryId]/payments/bulk-payment/components/upload-data-step.tsx",
    },
    "general-warning-background-faded": {
        purpose: "Faded yellow background for warning alerts/banners.",
        usageCount: 4,
        example: "components/alert.tsx",
    },
    "general-warning-foreground": {
        purpose: "Yellow text/icon color for warning status.",
        usageCount: 6,
        example: "components/formatted-date.tsx",
    },
    "general-tertiary": {
        purpose:
            "Alternate neutral background used for chrome like table headers.",
        usageCount: 23,
        example: "app/(treasury)/app/manage-treasuries/page.tsx",
    },
    "general-secondary": {
        purpose: "Alternate secondary-background variant, used sparingly.",
        usageCount: 3,
        example: "app/(treasury)/[treasuryId]/dashboard/export/page.tsx",
    },

    // Brand
    // --onboarding-primary used to live here (same value as brand-green) — deleted
    // during cleanup, 0 usages anywhere in app code.
    "brand-green": {
        purpose:
            "NEAR brand green (rgb(0,150,96)), used for letter-avatar fallback backgrounds and NEAR-network accents. Renamed from --brand-blue during cleanup — the old name didn't match the color.",
        usageCount: 7,
        example:
            "app/(treasury)/[treasuryId]/dashboard/components/deposit-modal.tsx",
    },

    // Chart
    // --chart-1..5 used to live here — deleted during cleanup: ui/chart.tsx supplies
    // its own per-series colors via a config object at render time, these were dead.
    "chart-area-fill": {
        purpose:
            "Area-fill color for the dashboard balance chart specifically.",
        usageCount: 1,
        example: "app/(treasury)/[treasuryId]/dashboard/components/chart.tsx",
    },

    // The full --sidebar-* token set (shadcn's standard Sidebar-component tokens) was
    // deleted during cleanup — this app has no shadcn Sidebar primitive
    // (components/sidebar.tsx is a custom nav styled with the Core tokens instead),
    // so all 8 were dead: defined in globals.css, referenced nowhere in app code.
};

// components/ui/* — 24 shadcn/Radix primitives.
export const primitives: ComponentEntry[] = [
    {
        name: "Alert",
        filePath: "components/ui/alert.tsx",
        usageCount: 4,
        variants: "variant: default | info | destructive",
    },
    {
        name: "Button",
        filePath: "components/ui/button.tsx",
        usageCount: 2,
        variants:
            "variant: default | destructive | outline | secondary | ghost | link | unstyled — size: default | sm | lg | icon | icon-sm | icon-lg",
        notes: "Almost every call site uses the components/button.tsx wrapper (93 files) instead of this directly.",
    },
    {
        name: "Card",
        filePath: "components/ui/card.tsx",
        usageCount: 3,
        notes: "No variants. Not the same component as components/card.tsx (PageCard) — see Duplicates.",
    },
    { name: "Checkbox", filePath: "components/ui/checkbox.tsx", usageCount: 9 },
    {
        name: "Collapsible",
        filePath: "components/ui/collapsible.tsx",
        usageCount: 7,
    },
    {
        name: "DateTimePicker / DatePickerPopover",
        filePath: "components/ui/datepicker.tsx",
        usageCount: 1,
        notes: "856 lines for a single direct consumer (features/proposals/components/proposal-filters.tsx). Known bug: opening the calendar renders a <div> inside a <tr> (the Day component override at line 535 returns a div instead of a td), causing a React hydration/DOM-nesting error — rendered here via the closed popover trigger to avoid spamming it on every page load.",
    },
    {
        name: "Dialog",
        filePath: "components/ui/dialog.tsx",
        usageCount: 2,
        notes: "Almost everything goes through components/modal.tsx (27 files) instead.",
    },
    {
        name: "DropdownMenu",
        filePath: "components/ui/dropdown-menu.tsx",
        usageCount: 4,
    },
    {
        name: "Form / FormField",
        filePath: "components/ui/form.tsx",
        usageCount: 15,
        notes: "react-hook-form wrapper set.",
    },
    {
        name: "Input",
        filePath: "components/ui/input.tsx",
        usageCount: 0,
        notes: "Only consumed via components/input.tsx wrapper.",
    },
    { name: "Label", filePath: "components/ui/label.tsx", usageCount: 7 },
    { name: "Popover", filePath: "components/ui/popover.tsx", usageCount: 8 },
    {
        name: "ScrollArea",
        filePath: "components/ui/scroll-area.tsx",
        usageCount: 9,
    },
    {
        name: "Select",
        filePath: "components/ui/select.tsx",
        usageCount: 9,
    },
    {
        name: "Separator",
        filePath: "components/ui/separator.tsx",
        usageCount: 2,
    },
    {
        name: "Skeleton",
        filePath: "components/ui/skeleton.tsx",
        usageCount: 27,
    },
    {
        name: "Slider",
        filePath: "components/ui/slider.tsx",
        usageCount: 1,
        notes: "Only consumed via components/slider.tsx wrapper.",
    },
    { name: "Switch", filePath: "components/ui/switch.tsx", usageCount: 4 },
    {
        name: "Table",
        filePath: "components/ui/table.tsx",
        usageCount: 1,
        notes: "Consumed via components/table.tsx wrapper (10 files).",
    },
    {
        name: "Tabs",
        filePath: "components/ui/tabs.tsx",
        usageCount: 1,
        notes: "Direct consumer: components/underline-tabs.tsx.",
    },
    {
        name: "Textarea",
        filePath: "components/ui/textarea.tsx",
        usageCount: 0,
        notes: "Only consumed via components/textarea.tsx wrapper.",
    },
    {
        name: "Toggle",
        filePath: "components/ui/toggle.tsx",
        usageCount: 0,
        variants: "variant: default | outline — size: default | sm | lg",
        notes: "No app-level consumer — only referenced internally by toggle-group.tsx for toggleVariants.",
    },
    {
        name: "ToggleGroup",
        filePath: "components/ui/toggle-group.tsx",
        usageCount: 0,
        notes: "No app-level consumer — its only consumer, components/tab-group.tsx, was deleted during cleanup (its 1 use, the settings page tab bar, migrated onto ResponsiveTabs to consolidate the app's two parallel tab families into one).",
    },
    {
        name: "Tooltip",
        filePath: "components/ui/tooltip.tsx",
        usageCount: 0,
        notes: "Only consumed via components/tooltip.tsx wrapper.",
    },
    {
        name: "Chart",
        filePath: "components/ui/chart.tsx",
        usageCount: 1,
        notes: "389 lines for a single call site (dashboard chart).",
    },
];

// High-usage components/*.tsx domain wrappers.
export const wrappers: ComponentEntry[] = [
    {
        name: "Button",
        filePath: "components/button.tsx",
        usageCount: 93,
        variants:
            "variant: default | destructive | outline | secondary | ghost | link — size: default | sm | lg | icon | icon-sm | icon-lg",
        notes: 'Custom "card"/"outline-destructive" variants (previously mapped onto secondary/outline) were removed to match stock ui/button.tsx exactly.',
    },
    {
        name: "PageCard",
        filePath: "components/card.tsx",
        usageCount: 40,
        notes: "Independent styling from ui/card.tsx — see Duplicates.",
    },
    {
        name: "Tooltip",
        filePath: "components/tooltip.tsx",
        usageCount: 33,
        notes: "Wraps ui/popover (touch) + ui/tooltip (pointer), switches by useMediaQuery('(hover: none)').",
    },
    {
        name: "Modal (Dialog)",
        filePath: "components/modal.tsx",
        usageCount: 27,
        notes: "Wraps ui/dialog.tsx with wallet-connector-popup interop + mobile bottom-drawer styling.",
    },
    {
        name: "PageComponentLayout",
        filePath: "components/page-component-layout.tsx",
        usageCount: 24,
        notes: "Page shell: header (sidebar toggle, back button, title, theme toggle, sign-in) + main.",
    },
    {
        name: "StepWizard",
        filePath: "components/step-wizard.tsx",
        usageCount: 18,
        notes: "Also exports StepIndicator, StepperHeader, InlineNextButton, ReviewStep.",
    },
    {
        name: "FormattedDate",
        filePath: "components/formatted-date.tsx",
        usageCount: 17,
    },
    {
        name: "InfoDisplay",
        filePath: "components/info-display.tsx",
        usageCount: 16,
    },
    {
        name: "EmptyState",
        filePath: "components/empty-state.tsx",
        usageCount: 15,
    },
    {
        name: "WarningMessage / SlotWarning",
        filePath: "components/warning-message.tsx",
        usageCount: 13,
        variants: "variant: banner | inline | tooltip",
    },
    {
        name: "Input",
        filePath: "components/input.tsx",
        usageCount: 14,
        notes: "Also exports ResponsiveInput.",
    },
    { name: "Table", filePath: "components/table.tsx", usageCount: 10 },
    { name: "Textarea", filePath: "components/textarea.tsx", usageCount: 9 },
    { name: "Address", filePath: "components/address.tsx", usageCount: 9 },
    {
        name: "Pill",
        filePath: "components/pill.tsx",
        usageCount: 8,
        variants: "variant: default | card | secondary | info | primary",
        notes: "One of 5 independent badge implementations — see Duplicates.",
    },
    {
        name: "TokenAmountDisplay / NetworkIconDisplay",
        filePath: "components/token-display.tsx",
        usageCount: 8,
    },
    {
        name: "NumberBadge",
        filePath: "components/number-badge.tsx",
        usageCount: 8,
        variants:
            "variant: default | secondary | accent | error — sizes: default | sm",
        notes: "One of 5 independent badge implementations — see Duplicates.",
    },
    {
        name: "CopyButton",
        filePath: "components/copy-button.tsx",
        usageCount: 7,
    },
    {
        name: "LargeInput",
        filePath: "components/large-input.tsx",
        usageCount: 8,
        notes: "The big amount field seen on swap/exchange and payment forms. Wraps ui/input with dynamic font-size shrink-to-fit. Always used with borderless + inside components/input-block.tsx (bg-muted card) — rendered bare it just looks like a normal bordered Input.",
    },
    {
        name: "TokenInput",
        filePath: "components/token-input.tsx",
        usageCount: 8,
        notes: "The full swap-style row: LargeInput + TokenSelect + balance/max button + USD estimate. react-hook-form-only (needs a FormProvider ancestor) — demoed here inside a local form.",
    },
    {
        name: "TokenSelectPopover",
        filePath: "components/token-select-popover.tsx",
        usageCount: 1,
        notes: "A second, simpler token picker (Popover + live bridge-token search) — separate from TokenSelect (the dialog-based picker TokenInput uses internally, 2 direct consumers). Two token-picker implementations, not shared.",
    },
];

export interface DuplicateMember {
    name: string;
    filePath: string;
    usageCount: number;
}

export interface DuplicateGroup {
    id: string;
    title: string;
    description: string;
    members: DuplicateMember[];
}

export const duplicateGroups: DuplicateGroup[] = [
    {
        id: "badges",
        title: "Badges / pills / tags — 5 independent implementations",
        description:
            "No shared components/ui/badge.tsx primitive exists at all. Each of these rolls its own cva variant set from scratch.",
        members: [
            { name: "Pill", filePath: "components/pill.tsx", usageCount: 8 },
            {
                name: "NetworkBadge",
                filePath: "components/network-badge.tsx",
                usageCount: 3,
            },
            {
                name: "NumberBadge",
                filePath: "components/number-badge.tsx",
                usageCount: 8,
            },
            {
                name: "RoleBadge",
                filePath: "components/role-badge.tsx",
                usageCount: 2,
            },
            {
                name: "GuestBadge",
                filePath: "components/guest-badge.tsx",
                usageCount: 1,
            },
        ],
    },
    {
        id: "cards",
        title: "Cards — 2 non-overlapping implementations",
        description:
            "components/ui/card.tsx (shadcn Card, border, no shadow) and components/card.tsx (PageCard, border, different radius/padding) don't share any code, and the app's dominant \"card\" look is carried by PageCard (40 consumers) rather than the shadcn primitive (3 consumers).",
        members: [
            {
                name: "Card (shadcn)",
                filePath: "components/ui/card.tsx",
                usageCount: 3,
            },
            {
                name: "PageCard",
                filePath: "components/card.tsx",
                usageCount: 40,
            },
        ],
    },
    {
        id: "alerts",
        title: "Alerts — layering inconsistency",
        description:
            "components/alert.tsx wraps ui/alert.tsx and adds a warning variant. info-alert.tsx and warning-alert.tsx import the components/alert.tsx wrapper. (error-alert.tsx used to bypass the wrapper by importing ui/alert directly — deleted as an orphan during cleanup, so that specific inconsistency is gone; the layering itself is still worth documenting.)",
        members: [
            {
                name: "Alert (shadcn)",
                filePath: "components/ui/alert.tsx",
                usageCount: 4,
            },
            {
                name: "Alert (wrapper, adds warning)",
                filePath: "components/alert.tsx",
                usageCount: 6,
            },
            {
                name: "InfoAlert (imports components/alert)",
                filePath: "components/info-alert.tsx",
                usageCount: 1,
            },
            {
                name: "WarningAlert (imports components/alert)",
                filePath: "components/warning-alert.tsx",
                usageCount: 1,
            },
        ],
    },
];

export interface RawColorHotspot {
    filePath: string;
    detail: string;
}

export const rawColorHotspots: RawColorHotspot[] = [
    {
        filePath: "app/globals.css:96",
        detail: "--brand-green token is misleadingly named — its value is green rgb(0, 150, 96), identical to --onboarding-primary.",
    },
    {
        filePath: "components/primary-color-provider.tsx:12-15",
        detail: "Independent hardcoded palette (WHITE, BLACK, DARK_TEXT, LIGHT_TEXT as literal rgb strings) duplicating values already in globals.css.",
    },
    {
        filePath: "components/icons/shield.tsx",
        detail: '33 occurrences of fill="#262626" plus #171717 and #F5F5F5, none referencing tokens.',
    },
    {
        filePath:
            "components/sidebar.tsx:250,267 + treasury-layout-client.tsx:39",
        detail: "Same raw bg-[#262626] Tailwind arbitrary value duplicated across 3 files.",
    },
    {
        filePath:
            "app/(treasury)/[treasuryId]/settings/components/general-tab.tsx:28-45",
        detail: "18-entry hardcoded hex color-picker palette, none referencing tokens.",
    },
    {
        filePath:
            "~87 hex literals / 18 inline rgb() / 8 arbitrary bg-[#...] classes",
        detail: "Spread across 14 files outside globals.css (SVG gradients, one-off backgrounds) — full list not yet catalogued here.",
    },
];

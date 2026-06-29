"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useNextStep } from "nextstepjs";
import { useEffect, useState } from "react";
import { SlotWarning } from "@/components/warning-message";
import { ConfidentialBanner } from "@/features/confidential/components/confidential-banner";
import { CreateBanner } from "@/features/onboarding/components/create-banner";
import { TOUR_NAMES } from "@/features/onboarding/steps/dashboard";
import {
    PAGE_TOUR_SELECTORS,
    useGuestSaveTour,
} from "@/features/onboarding/steps/page-tours";
import { useCustomRequestsEnabled } from "@/features/proposal-templates/hooks/use-custom-requests-enabled";
import { useProposalTemplates } from "@/features/proposal-templates/hooks/use-proposal-templates";
import { manifestIdOf } from "@/features/proposal-templates/manifest";
import { useProposals } from "@/hooks/use-proposals";
import { useSubscription } from "@/hooks/use-subscription";
import { useTreasury } from "@/hooks/use-treasury";
import { useSaveTreasuryMutation } from "@/hooks/use-treasury-mutations";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { useResponsiveSidebar } from "@/stores/sidebar-store";
import { ArrowUpDown } from "./animate-ui/icons/arrow-up-down";
import { Bookmark } from "./animate-ui/icons/bookmark";
import { ChartColumn } from "./animate-ui/icons/chart-column";
import { ChartNoAxesCombined } from "./animate-ui/icons/chart-no-axes-combined";
import { CodeXml } from "./animate-ui/icons/code-xml";
import { ContactRound } from "./animate-ui/icons/contact-round";
import { CreditCard } from "./animate-ui/icons/credit-card";
import { AnimateIcon, type IconProps } from "./animate-ui/icons/icon";
import { MessageCircleQuestion } from "./animate-ui/icons/message-circle-question";
import { Send } from "./animate-ui/icons/send";
import { Settings } from "./animate-ui/icons/settings";
import { Users } from "./animate-ui/icons/users";
import { ApprovalInfo } from "./approval-info";
import { Button } from "./button";
import { GuestBadge } from "./guest-badge";
import { NumberBadge } from "./number-badge";
import { SponsoredActionsLimitNotice } from "./sponsored-actions-limit-notice";
import { SupportCenterModal } from "./support-center-modal";
import { TreasurySelector } from "./treasury-selector";

interface NavLinkProps {
    isActive: boolean;
    icon: React.ComponentType<IconProps<"default">>;
    label: string;
    tooltipContent?: React.ReactNode;
    showBadge?: boolean;
    badgeCount?: number;
    endAdornment?: React.ReactNode;
    onClick: () => void;
    /** When set, the link renders as a real `<a>` (Next `Link`) so middle-click / open-in-new-tab / prefetch work. */
    href?: string;
    id?: string;
    showLabels?: boolean;
}

function NavLink({
    isActive,
    icon: Icon,
    label,
    tooltipContent,
    showBadge = false,
    badgeCount = 0,
    endAdornment,
    onClick,
    href,
    id,
    showLabels = true,
}: NavLinkProps) {
    const content = (
        <div className="flex w-full min-w-0 items-center gap-2">
            <div className="flex min-w-0 items-center gap-3">
                <Icon className="size-5 shrink-0" />
                {showLabels && <span className="truncate">{label}</span>}
            </div>
            {showLabels && (showBadge || endAdornment) && (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    {showBadge && <NumberBadge number={badgeCount} />}
                    {endAdornment}
                </div>
            )}
        </div>
    );
    return (
        <AnimateIcon animateOnHover="default" asChild>
            <Button
                id={id}
                variant="link"
                tooltipContent={
                    !showLabels ? (tooltipContent ?? label) : undefined
                }
                side="right"
                onClick={onClick}
                asChild={!!href}
                className={cn(
                    "flex relative items-center group justify-between gap-3 text-sm font-medium transition-colors",
                    showLabels ? "px-3 py-[5.5px]" : "px-3 justify-center",
                    isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
            >
                {href ? <Link href={href}>{content}</Link> : content}
            </Button>
        </AnimateIcon>
    );
}

type NavTranslationKey =
    | "dashboard"
    | "requests"
    | "payments"
    | "exchange"
    | "earn"
    | "addressBook"
    | "members"
    | "settings";

const topNavLinks: {
    path: string;
    labelKey: NavTranslationKey;
    icon: React.ComponentType<IconProps<"default">>;
    roleRequired?: boolean;
    id?: string;
}[] = [
    { path: "", labelKey: "dashboard", icon: ChartColumn },
    { path: "requests", labelKey: "requests", icon: Send },
    {
        path: "payments",
        labelKey: "payments",
        icon: CreditCard,
        roleRequired: true,
    },
    {
        path: "exchange",
        labelKey: "exchange",
        icon: ({ className, ...props }) => (
            <ArrowUpDown {...props} className={cn(className, "rotate-90")} />
        ),
        roleRequired: true,
    },
    {
        path: "earn",
        labelKey: "earn",
        icon: ChartNoAxesCombined,
        id: "earn-new",
    },
];

const bottomNavLinks: {
    path: string;
    labelKey: NavTranslationKey;
    icon: React.ComponentType<IconProps<"default">>;
    id?: string;
    showNewPill?: boolean;
    memberRequired?: boolean;
}[] = [
    {
        path: "address-book",
        labelKey: "addressBook",
        icon: ContactRound,
        id: "address-book-link",
        memberRequired: true,
    },
    {
        path: "members",
        labelKey: "members",
        icon: Users,
        id: "dashboard-step4",
    },
    { path: "settings", labelKey: "settings", icon: Settings },
];

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [hasInitialized, setHasInitialized] = useState(false);
    const [supportModalOpen, setSupportModalOpen] = useState(false);
    const [templatesExpanded, setTemplatesExpanded] = useState(true);
    const { accountId } = useNear();
    const tNav = useTranslations("nav");
    const tPages = useTranslations("pages");
    const tCommon = useTranslations("common");
    const tCustom = useTranslations("customTemplates");
    const { currentTour } = useNextStep();

    const {
        isGuestTreasury,
        isLoading: isLoadingGuestTreasury,
        treasuryId,
        isSaved,
    } = useTreasury();
    const { data: proposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        ...(accountId && {
            voter_votes: `${accountId}:No Voted`,
        }),
    });
    const { data: subscription } = useSubscription(treasuryId);
    const { data: proposalTemplates } = useProposalTemplates();
    const { data: customRequestsEnabled } = useCustomRequestsEnabled();

    const { isMobile, mounted, isSidebarOpen: isOpen } = useResponsiveSidebar();

    const isReduced = !isMobile && !isOpen;
    const showLabels = isMobile ? isOpen : !isReduced;
    // Only pinned (and enabled, slug-resolvable) templates show under the sidebar chevron; the rest
    // live on the Request Templates index. Pinning is toggled from that page's ⋮ menu.
    const pinnedTemplates = (proposalTemplates ?? []).filter(
        (template) =>
            template.enabled &&
            template.pinned &&
            manifestIdOf(template.manifest),
    );
    const saveTreasuryMutation = useSaveTreasuryMutation(accountId, treasuryId);
    useGuestSaveTour(accountId ?? undefined, isSaved ?? false);

    // Dashboard tour step 5 opens treasury selector; close it once that tour ends
    // so follow-up tours (e.g. Earn announcement) are not hidden behind dropdown.
    useEffect(() => {
        if (currentTour !== TOUR_NAMES.DASHBOARD) {
            setDropdownOpen(false);
        }
    }, [currentTour]);

    // Mark as initialized after first render with mounted state
    useEffect(() => {
        if (mounted && !hasInitialized) {
            // Small delay to allow state to settle before enabling transitions
            const timer = setTimeout(() => setHasInitialized(true), 50);
            return () => clearTimeout(timer);
        }
    }, [mounted, hasInitialized]);

    // Don't render sidebar content until mounted to prevent hydration issues
    if (!mounted) {
        // Render placeholder that preserves layout space
        return (
            <div className="hidden lg:block lg:static lg:w-16 h-dvh lg:h-screen bg-card border-r" />
        );
    }

    return (
        <>
            {/* Backdrop for mobile */}
            {isOpen && (
                <div
                    className="fixed inset-0 z-30 bg-black/50 lg:hidden"
                    onClick={onClose}
                />
            )}

            {/* Sidebar */}
            <div
                className={cn(
                    "fixed left-0 top-0 z-40 flex gap-2 h-dvh lg:h-screen flex-col bg-card border-r lg:static lg:z-auto overflow-hidden max-lg:pt-[env(safe-area-inset-top)]",
                    hasInitialized &&
                        "transition-[width,transform] duration-300",
                    isMobile
                        ? isOpen
                            ? "w-60 translate-x-0"
                            : "-translate-x-full"
                        : isOpen
                          ? "w-60"
                          : "w-16",
                )}
            >
                <div className="border-b">
                    <div className="p-3.5 flex flex-col gap-2">
                        <TreasurySelector
                            reducedMode={isReduced}
                            isOpen={dropdownOpen}
                            onOpenChange={setDropdownOpen}
                        />
                        <div
                            className={cn(
                                "px-3",
                                isReduced ? "hidden" : "px-3.5",
                            )}
                        >
                            {isGuestTreasury && !isLoadingGuestTreasury ? (
                                <div className="flex gap-2">
                                    <GuestBadge
                                        id={PAGE_TOUR_SELECTORS.GUEST_BADGE.slice(
                                            1,
                                        )}
                                        showTooltip
                                        side="right"
                                    />
                                    {accountId && !isReduced && !isSaved && (
                                        <AnimateIcon
                                            animateOnHover="default"
                                            asChild
                                        >
                                            <Button
                                                id={PAGE_TOUR_SELECTORS.GUEST_SAVE_BTN.slice(
                                                    1,
                                                )}
                                                variant="outline"
                                                size="sm"
                                                className="w-fit h-6 justify-center gap-1.5"
                                                tooltipContent={tNav(
                                                    "saveGuestTreasury",
                                                )}
                                                side="right"
                                                onClick={() =>
                                                    saveTreasuryMutation.mutate()
                                                }
                                                disabled={
                                                    saveTreasuryMutation.isPending
                                                }
                                            >
                                                <Bookmark className="size-3 shrink-0" />
                                                {tCommon("save")}
                                            </Button>
                                        </AnimateIcon>
                                    )}
                                </div>
                            ) : (
                                <ApprovalInfo variant="pupil" side="right" />
                            )}
                        </div>
                    </div>
                </div>

                <nav
                    className={cn(
                        "flex flex-col gap-1 pb-2 flex-1",
                        isReduced ? "px-2" : "px-3.5",
                    )}
                >
                    {topNavLinks.map((link) => {
                        const href = treasuryId
                            ? `/${treasuryId}${link.path ? `/${link.path}` : ""}`
                            : `/${link.path ? `/${link.path}` : ""}`;
                        const isActive = pathname === href;
                        const showBadge =
                            link.path === "requests" &&
                            (proposals?.total ?? 0) > 0;

                        return (
                            <NavLink
                                id={link.id}
                                key={link.path}
                                isActive={isActive}
                                icon={link.icon}
                                label={
                                    link.labelKey === "earn"
                                        ? tPages("earn.title")
                                        : tNav(link.labelKey)
                                }
                                showBadge={showBadge}
                                badgeCount={proposals?.total ?? 0}
                                showLabels={showLabels}
                                onClick={() => {
                                    router.push(href);
                                    if (isMobile) onClose();
                                }}
                            />
                        );
                    })}

                    {customRequestsEnabled && (
                        <div className="flex flex-col gap-1">
                            {/* Header is two targets: the label navigates to the index, the chevron
                                (only when something is pinned) toggles the pinned list — so they
                                can't be nested buttons. */}
                            <div
                                className={cn(
                                    "flex items-center rounded-md transition-colors",
                                    pathname ===
                                        `/${treasuryId}/custom-templates`
                                        ? "bg-accent text-accent-foreground"
                                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                                )}
                            >
                                <AnimateIcon animateOnHover="default" asChild>
                                    <Button
                                        id="request-templates-nav"
                                        variant="link"
                                        asChild
                                        // Collapsed sidebar is icon-only, so restore the hover label
                                        // there (and keep the tour selector id on this element).
                                        tooltipContent={
                                            showLabels
                                                ? undefined
                                                : tCustom("pageTitle")
                                        }
                                        side="right"
                                        className={cn(
                                            // `justify-start` overrides the Button's base
                                            // `justify-center`, which would otherwise centre the icon
                                            // in the flex-1 width and shift it right when no chevron.
                                            "flex min-w-0 flex-1 items-center justify-start gap-3 py-[5.5px] font-medium text-inherit text-sm hover:text-inherit",
                                            showLabels
                                                ? "px-3"
                                                : "justify-center px-3",
                                        )}
                                    >
                                        <Link
                                            href={`/${treasuryId}/custom-templates`}
                                            onClick={() => {
                                                if (isMobile) onClose();
                                            }}
                                        >
                                            <CodeXml className="size-5 shrink-0" />
                                            {showLabels && (
                                                <span className="truncate">
                                                    {tCustom("pageTitle")}
                                                </span>
                                            )}
                                        </Link>
                                    </Button>
                                </AnimateIcon>
                                {showLabels && pinnedTemplates.length > 0 && (
                                    <button
                                        type="button"
                                        aria-label={
                                            templatesExpanded
                                                ? tCustom("collapsePinned")
                                                : tCustom("expandPinned")
                                        }
                                        aria-expanded={templatesExpanded}
                                        onClick={() =>
                                            setTemplatesExpanded(
                                                (value) => !value,
                                            )
                                        }
                                        className="shrink-0 cursor-pointer px-2 py-[5.5px]"
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "size-4 transition-transform",
                                                !templatesExpanded &&
                                                    "-rotate-90",
                                            )}
                                        />
                                    </button>
                                )}
                            </div>
                            {showLabels && templatesExpanded && (
                                // Indent so a child's icon lines up under the parent's *text*:
                                // header text starts at 44px (px-3 + 20px icon + gap-3); the child's
                                // own NavLink adds px-3 (12px), so the wrapper supplies the other 32.
                                <div className="flex flex-col gap-1 pl-8">
                                    {pinnedTemplates.map((template) => {
                                        const href = `/${treasuryId}/custom-templates/${manifestIdOf(template.manifest)}`;
                                        return (
                                            <NavLink
                                                key={template.id}
                                                isActive={pathname === href}
                                                icon={Bookmark}
                                                label={template.name}
                                                showLabels={showLabels}
                                                href={href}
                                                onClick={() => {
                                                    if (isMobile) onClose();
                                                }}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </nav>

                <div className="hidden lg:flex flex-col w-full justify-center items-center gap-2">
                    <div
                        className={cn(
                            "w-full px-3.5 flex flex-col gap-2",
                            isReduced && "hidden",
                        )}
                    >
                        <SlotWarning
                            slot="data.balances"
                            headingClassName="font-medium"
                            iconPosition="top"
                            bodyClassName="text-xs"
                        />
                        <SlotWarning
                            slot="app"
                            headingClassName="font-medium"
                            iconPosition="top"
                            bodyClassName="text-xs"
                        />
                    </div>
                    <CreateBanner disabled={isReduced} />
                    <div className={cn(!isReduced && "px-3.5 w-full flex")}>
                        <ConfidentialBanner
                            type={isReduced ? "mini" : "default"}
                            className={cn(isReduced && "size-5")}
                        />
                    </div>
                </div>

                <div
                    className={cn(
                        "flex flex-col gap-1 pb-[calc(0.5rem+env(safe-area-inset-bottom))] lg:pb-2",
                        isReduced ? "px-2" : "px-3.5",
                    )}
                >
                    {!isGuestTreasury && (
                        <SponsoredActionsLimitNotice
                            treasuryId={treasuryId}
                            subscription={subscription}
                            enableFloatingPopup={true}
                            showSidebarCard={true}
                            onContactClick={() => setSupportModalOpen(true)}
                        />
                    )}
                    {bottomNavLinks
                        .filter(
                            (link) => !(link.memberRequired && isGuestTreasury),
                        )
                        .map((link) => {
                            const href = treasuryId
                                ? `/${treasuryId}${link.path ? `/${link.path}` : ""}`
                                : `/${link.path ? `/${link.path}` : ""}`;
                            const isActive = pathname === href;

                            return (
                                <NavLink
                                    id={link.id}
                                    key={link.path}
                                    isActive={isActive}
                                    icon={link.icon}
                                    label={tNav(link.labelKey)}
                                    showLabels={!isReduced}
                                    onClick={() => {
                                        router.push(href);
                                        if (isMobile) onClose();
                                    }}
                                />
                            );
                        })}

                    <NavLink
                        id="help-support-link"
                        isActive={false}
                        icon={MessageCircleQuestion}
                        label={tNav("helpSupport")}
                        showLabels={!isReduced}
                        onClick={() => {
                            // close if mobile
                            if (isMobile) onClose();
                            setSupportModalOpen(true);
                        }}
                    />
                </div>
            </div>

            <SupportCenterModal
                open={supportModalOpen}
                onOpenChange={setSupportModalOpen}
            />
        </>
    );
}

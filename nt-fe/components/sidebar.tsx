"use client";

import { usePathname, useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TreasurySelector } from "./treasury-selector";
import { cn } from "@/lib/utils";
import {
    Send,
    CreditCard,
    Users,
    Settings,
    HelpCircle,
    type LucideIcon,
    ArrowRightLeft,
    ChartColumn,
} from "lucide-react";
import { ApprovalInfo } from "./approval-info";
import { Button } from "./button";
import { useProposals } from "@/hooks/use-proposals";
import { useSubscription } from "@/hooks/use-subscription";
import { NumberBadge } from "./number-badge";
import { Pill } from "./pill";
import { useTreasury } from "@/hooks/use-treasury";
import { useResponsiveSidebar } from "@/stores/sidebar-store";
import { SupportCenterModal } from "./support-center-modal";
import { SponsoredActionsLimitNotice } from "./sponsored-actions-limit-notice";
import { useNear } from "@/stores/near-store";

interface NavLinkProps {
    isActive: boolean;
    icon: LucideIcon;
    label: string;
    showBadge?: boolean;
    badgeCount?: number;
    onClick: () => void;
    id?: string;
    showLabels?: boolean;
}

function NavLink({
    isActive,
    icon: Icon,
    label,
    showBadge = false,
    badgeCount = 0,
    onClick,
    id,
    showLabels = true,
}: NavLinkProps) {
    return (
        <Button
            id={id}
            variant="link"
            tooltipContent={!showLabels ? label : undefined}
            side="right"
            onClick={onClick}
            className={cn(
                "flex relative items-center justify-between gap-3 text-sm font-medium transition-colors",
                showLabels ? "px-3 py-[5.5px]" : "justify-center",
                isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
        >
            <div className="flex items-center gap-3">
                <Icon className="size-5 shrink-0" />
                {showLabels && label}
            </div>
            {showBadge && showLabels && <NumberBadge number={badgeCount} />}
        </Button>
    );
}

const topNavLinks: {
    path: string;
    label: string;
    icon: LucideIcon;
    roleRequired?: boolean;
    id?: string;
}[] = [
    { path: "", label: "Dashboard", icon: ChartColumn },
    { path: "requests", label: "Requests", icon: Send },
    {
        path: "payments",
        label: "Payments",
        icon: CreditCard,
        roleRequired: true,
    },
    {
        path: "exchange",
        label: "Exchange",
        icon: ArrowRightLeft,
        roleRequired: true,
    },
    // { path: "earn", label: "Earn", icon: Database, roleRequired: true },
    // { path: "vesting", label: "Vesting", icon: Clock10, roleRequired: true },
];

const bottomNavLinks: {
    path: string;
    label: string;
    icon: LucideIcon;
    id?: string;
}[] = [
    { path: "members", label: "Members", icon: Users, id: "dashboard-step4" },
    { path: "settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const params = useParams();
    const treasuryId = params?.treasuryId as string | undefined;
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [hasInitialized, setHasInitialized] = useState(false);
    const [supportModalOpen, setSupportModalOpen] = useState(false);
    const { accountId } = useNear();

    const { data: proposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        voter_votes: `${accountId}:No Voted`,
    });
    const { data: subscription } = useSubscription(treasuryId);

    const { isGuestTreasury, isLoading: isLoadingGuestTreasury } =
        useTreasury();
    const { isMobile, mounted, isSidebarOpen: isOpen } = useResponsiveSidebar();

    const isReduced = !isMobile && !isOpen;

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
            <div className="hidden lg:block lg:static lg:w-16 h-screen bg-card border-r" />
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
                    "fixed left-0 top-0 z-40 flex gap-2 h-screen flex-col bg-card border-r lg:static lg:z-auto overflow-hidden",
                    hasInitialized && "transition-all duration-300",
                    isMobile
                        ? isOpen
                            ? "w-56 translate-x-0"
                            : "-translate-x-full"
                        : isOpen
                          ? "w-56"
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
                                <Pill
                                    variant="info"
                                    side="right"
                                    title="Guest"
                                    info="You are a guest of this treasury. You can only view the data. Creating requests, adding members, or making any changes is not allowed because you are not a member of the team."
                                />
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
                        const showLabels = isMobile ? isOpen : !isReduced;

                        return (
                            <NavLink
                                key={link.path}
                                isActive={isActive}
                                icon={link.icon}
                                label={link.label}
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
                </nav>

                <div
                    className={cn(
                        "flex flex-col gap-1 pb-2",
                        isReduced ? "px-2" : "px-3.5",
                    )}
                >
                    {!isGuestTreasury && (
                        <SponsoredActionsLimitNotice
                            treasuryId={treasuryId}
                            subscription={subscription}
                            showSidebarCard={!isReduced}
                            enableFloatingPopup={!isMobile}
                            onContactClick={() => setSupportModalOpen(true)}
                        />
                    )}
                    {bottomNavLinks.map((link) => {
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
                                label={link.label}
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
                        icon={HelpCircle}
                        label="Help & Support"
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

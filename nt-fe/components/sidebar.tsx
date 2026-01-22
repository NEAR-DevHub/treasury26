"use client";

import { usePathname, useParams, useRouter } from "next/navigation";
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
import { NumberBadge } from "./number-badge";
import { Pill } from "./pill";
import { useIsGuestTreasury } from "@/hooks/use-is-guest-treasury";

interface NavLinkProps {
  isActive: boolean;
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  showBadge?: boolean;
  badgeCount?: number;
  onClick: () => void;
  id?: string;
}

const DISABLED_TOOLTIP_CONTENT = "You are not authorized to access this page. Please contact governance to provide you with Requestor role.";

function NavLink({
  isActive,
  icon: Icon,
  label,
  disabled = false,
  showBadge = false,
  badgeCount = 0,
  onClick,
  id,
}: NavLinkProps) {
  return (
    <Button
      id={id}
      variant="link"
      disabled={disabled}
      tooltipContent={disabled ? DISABLED_TOOLTIP_CONTENT : undefined}
      onClick={onClick}
      className={cn(
        "flex items-center justify-between px-3 py-[5.5px] gap-3 h-8 text-sm font-medium transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className="size-5 shrink-0" />
        {label}
      </div>
      {showBadge && (
        <NumberBadge number={badgeCount} />
      )}
    </Button>
  );
}

const topNavLinks: { path: string; label: string; icon: LucideIcon; roleRequired?: boolean; id?: string }[] = [
  { path: "", label: "Dashboard", icon: ChartColumn },
  { path: "requests", label: "Requests", icon: Send },
  { path: "payments", label: "Payments", icon: CreditCard, roleRequired: true },
  { path: "exchange", label: "Exchange", icon: ArrowRightLeft, roleRequired: true },
  // { path: "earn", label: "Earn", icon: Database, roleRequired: true },
  // { path: "vesting", label: "Vesting", icon: Clock10, roleRequired: true },
];

const bottomNavLinks: { path: string; label: string; icon: LucideIcon; id?: string }[] = [
  { path: "members", label: "Members", icon: Users, id: "dashboard-step4" },
  { path: "settings", label: "Settings", icon: Settings },
  { path: "help", label: "Help & Support", icon: HelpCircle },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams();
  const treasuryId = params?.treasuryId as string | undefined;

  const { data: proposals } = useProposals(treasuryId, {
    statuses: ["InProgress"],
  })

  const { isGuestTreasury, isLoading: isLoadingGuestTreasury } = useIsGuestTreasury();

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
          "fixed left-0 top-0 z-40 flex gap-2 h-screen w-56 flex-col bg-card border-r transition-transform duration-300 lg:relative lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-b">
          <div className="p-3.5 flex flex-col gap-2">
            <TreasurySelector />
            <div className="px-3">
              {isGuestTreasury && !isLoadingGuestTreasury ? (
                <Pill variant="info" side="right" title="Guest" info="You are a guest of this treasury. You can only view the data. Creating requests, adding members, or making any changes is not allowed because you are not a member of the team." />
              ) :
                (<ApprovalInfo variant="pupil" side="right" />)}
            </div>
          </div>
        </div>

        <nav className="flex-1 flex flex-col gap-1 px-3.5">
          {topNavLinks.map((link) => {
            const href = treasuryId
              ? `/${treasuryId}${link.path ? `/${link.path}` : ""}`
              : `/${link.path ? `/${link.path}` : ""}`;
            const isActive = pathname === href;
            const showBadge = link.path === "requests" && (proposals?.total ?? 0) > 0;

            return (
              <NavLink
                key={link.path}
                isActive={isActive}
                icon={link.icon}
                label={link.label}
                showBadge={showBadge}
                badgeCount={proposals?.total ?? 0}
                onClick={() => {
                  router.push(href);
                  onClose();
                }}
              />
            );
          })}
        </nav>

        <div className="px-3.5 flex flex-col gap-1 pb-2">
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
                onClick={() => {
                  router.push(href);
                  onClose();
                }}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

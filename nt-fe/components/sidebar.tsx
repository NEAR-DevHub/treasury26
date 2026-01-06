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
  Database,
  Clock10,
  ArrowRightLeft,
  ChartColumn,
} from "lucide-react";
import { ApprovalInfo } from "./approval-info";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { isRequestor } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { Button } from "./button";
import { useProposals } from "@/hooks/use-proposals";

interface NavLinkProps {
  isActive: boolean;
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  showBadge?: boolean;
  badgeCount?: number;
  onClick: () => void;
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
}: NavLinkProps) {
  return (
    <Button
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
        <span className="flex size-5 items-center justify-center rounded-[8px] px-2 py-[3px] bg-orange-500 text-xs font-semibold text-white">
          {badgeCount}
        </span>
      )}
    </Button>
  );
}

const topNavLinks: { path: string; label: string; icon: LucideIcon; roleRequired?: boolean }[] = [
  { path: "", label: "Dashboard", icon: ChartColumn },
  { path: "requests", label: "Requests", icon: Send },
  { path: "payments", label: "Payments", icon: CreditCard, roleRequired: true },
  { path: "exchange", label: "Exchange", icon: ArrowRightLeft, roleRequired: true },
  { path: "earn", label: "Earn", icon: Database, roleRequired: true },
  { path: "vesting", label: "Vesting", icon: Clock10, roleRequired: true },
];

const bottomNavLinks: { path: string; label: string; icon: LucideIcon }[] = [
  { path: "members", label: "Members", icon: Users },
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
  const { accountId } = useNear();
  const { data: policy } = useTreasuryPolicy(treasuryId);

  const isUserInRequestorRole = policy ? isRequestor(policy, accountId ?? "") : false;
  const { data: proposals } = useProposals(treasuryId, {
    statuses: ["InProgress"],
  })


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
              <ApprovalInfo variant="pupil" />
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
            const isRoleRequired = !link.roleRequired || isUserInRequestorRole;

            return (
              <NavLink
                key={link.path}
                isActive={isActive}
                icon={link.icon}
                label={link.label}
                disabled={!isRoleRequired}
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

        <div className="px-3.5 flex flex-col pb-2">
          {bottomNavLinks.map((link) => {
            const href = treasuryId
              ? `/${treasuryId}${link.path ? `/${link.path}` : ""}`
              : `/${link.path ? `/${link.path}` : ""}`;
            const isActive = pathname === href;

            return (
              <NavLink
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

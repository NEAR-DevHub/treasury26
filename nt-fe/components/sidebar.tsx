"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { TreasurySelector } from "./treasury-selector";
import { Separator } from "@/components/ui/separator";
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

const navLinks: { path: string; label: string; icon: LucideIcon }[] = [
  { path: "", label: "Dashboard", icon: ChartColumn },
  { path: "requests", label: "Requests", icon: Send },
  { path: "payments", label: "Payments", icon: CreditCard },
  { path: "exchange", label: "Exchange", icon: ArrowRightLeft },
  { path: "earn", label: "Earn", icon: Database },
  { path: "vesting", label: "Vesting", icon: Clock10 },
  { path: "members", label: "Members", icon: Users },
  { path: "settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();
  const params = useParams();
  const treasuryId = params?.treasuryId as string | undefined;

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
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="border-b">
          <div className="p-3.5">
            <TreasurySelector />
          </div>
        </div>

        <nav className="flex-1 flex flex-col gap-1 px-3.5">
          {navLinks.map((link) => {
            const Icon = link.icon;
            const href = treasuryId ? `/${treasuryId}${link.path ? `/${link.path}` : ''}` : `/${link.path ? `/${link.path}` : ''}`;
            const isActive = pathname === href;
            const showBadge = link.path === "requests";

            return (
              <Link
                key={link.path}
                href={href}
                onClick={onClose}
                className={cn(
                  "flex items-center rounded-[6px] justify-between gap-3 px-3 py-[5.5px] text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon className="h-5 w-5" />
                  {link.label}
                </div>
                {showBadge && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange-500 text-xs font-semibold text-white">
                    0
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="px-3.5 py-2">
          <Link
            href={treasuryId ? `/${treasuryId}/help` : "/help"}
            onClick={onClose}
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <HelpCircle className="h-5 w-5" />
            Help & Support
          </Link>
        </div>
      </div>
    </>
  );
}

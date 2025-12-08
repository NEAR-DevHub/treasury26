"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TreasurySelector } from "./treasury-selector";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Send,
  CreditCard,
  ArrowLeftRight,
  Layers,
  Clock,
  BookUser,
  Users,
  Settings,
  HelpCircle,
  type LucideIcon,
  PanelsTopLeft,
  Menu,
  Database,
} from "lucide-react";

const navLinks: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/app", label: "Dashboard", icon: PanelsTopLeft },
  { href: "/app/requests", label: "Requests", icon: Send },
  { href: "/app/payments", label: "Payments", icon: CreditCard },
  { href: "/app/exchange", label: "Exchange", icon: ArrowLeftRight },
  { href: "/app/earn", label: "Earn", icon: Layers },
  { href: "/app/vesting", label: "Vesting", icon: Clock },
  { href: "/app/address-book", label: "Address Book", icon: BookUser },
  { href: "/app/members", label: "Members", icon: Users },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

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
          "fixed left-0 top-0 z-40 flex h-screen w-64 flex-col bg-sidebar border-r transition-transform duration-300 lg:relative lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center gap-3 p-3 pb-2">
          <div className="flex items-center justify-center w-8 h-8 bg-foreground rounded-[8px] shrink-0">
            <Database className="h-4 w-4 text-background" />
          </div>
          <h2 className="text-md font-semibold tracking-wider uppercase">Treasury</h2>
        </div>

        <Separator />

        <div className="px-3 py-2 w-full h-fit">
          <TreasurySelector />
        </div>

        <Separator />

        <nav className="flex-1 space-y-1 p-4">
          {navLinks.map((link) => {
            const Icon = link.icon;
            const isActive = pathname === link.href;
            const showBadge = link.href === "/app/requests";

            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={onClose}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-[8px] px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground border-l-4 border-sidebar-primary"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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

        <Separator />

        <div className="p-4">
          <Link
            href="/app/help"
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

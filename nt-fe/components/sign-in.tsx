"use client";

import { useState } from "react";
import { LogIn, LogOut, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/button";
import { useNear } from "@/stores/near-store";
import { useRouter } from "next/navigation";
import { User } from "./user";

export function SignIn() {
  const { accountId: signedAccountId, isInitializing, connect, disconnect } = useNear();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  if (isInitializing) {
    return (
      <Button disabled className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </Button>
    );
  }

  if (!signedAccountId) {
    return (
      <Button
        onClick={connect}
        className="flex items-center gap-2"
      >
        <LogIn className="h-4 w-4" />
        Connect Wallet
      </Button>
    );
  }

  return (
    <div className="relative">
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-muted cursor-pointer"
        onClick={() => setIsMenuOpen(!isMenuOpen)}
      >
        <div className="hidden md:block">
          <User accountId={signedAccountId} withLink={false} size="md" />
        </div>
        <div className="flex md:hidden">
          <User accountId={signedAccountId} withLink={false} size="sm" iconOnly />
        </div>
        <ChevronDown className="h-4 w-4 text-muted-foreground hidden sm:inline" />
      </div>

      {isMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="absolute right-0 mt-2 w-48 bg-popover border border-border rounded-lg shadow-lg z-20">
            <div className="p-2 border-b border-border">
              <p className="text-xs text-muted-foreground break-all">{signedAccountId}</p>
            </div>
            <div className="p-1">
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-sm"
                onClick={() => {
                  disconnect();
                  setIsMenuOpen(false);
                }}
              >
                <LogOut className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

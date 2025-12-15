"use client";

import { useState } from "react";
import { LogIn, LogOut, User, ChevronDown } from "lucide-react";
import { Button } from "@/components/button";
import { useNear } from "@/stores/near-store";
import { useRouter } from "next/navigation";

export function SignIn() {
  const { accountId: signedAccountId, isInitializing, connect, disconnect } = useNear();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const router = useRouter();

  if (isInitializing) {
    return (
      <Button disabled className="flex items-center gap-2 bg-blue-600 text-white">
        <LogIn className="h-4 w-4" />
        Loading...
      </Button>
    );
  }

  if (!signedAccountId) {
    return (
      <Button
        onClick={connect}
        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white"
      >
        <LogIn className="h-4 w-4" />
        Sign In
      </Button>
    );
  }

  // Format account ID for display (show first and last chars for long names)
  const displayName =
    signedAccountId.length > 20
      ? `${signedAccountId.slice(0, 8)}...${signedAccountId.slice(-8)}`
      : signedAccountId;

  return (
    <div className="relative">
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-muted cursor-pointer"
        onClick={() => setIsMenuOpen(!isMenuOpen)}
      >
        <div className="h-8 w-8 rounded-full bg-blue-600 flex items-center justify-center">
          <User className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-medium hidden sm:inline">{displayName}</span>
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
                  disconnect().then(() => {
                    router.push("/app");
                  });
                  setIsMenuOpen(false);
                }}
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

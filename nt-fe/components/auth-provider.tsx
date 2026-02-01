"use client";

import { useEffect, useState } from "react";
import { useNearStore } from "@/stores/near-store";
import { AcceptTermsModal } from "./accept-terms-modal";
import { Loader2 } from "lucide-react";

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { isInitializing, isAuthenticated, hasAcceptedTerms, checkAuth } =
    useNearStore();

  const [hasCheckedAuth, setHasCheckedAuth] = useState(false);

  // Check existing auth on mount
  useEffect(() => {
    const check = async () => {
      await checkAuth();
      setHasCheckedAuth(true);
    };
    check();
  }, [checkAuth]);

  // Show loading state while checking auth
  if (!hasCheckedAuth || isInitializing) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Show terms modal if authenticated but terms not accepted
  const showTermsModal = isAuthenticated && !hasAcceptedTerms;

  return (
    <>
      {children}
      <AcceptTermsModal open={showTermsModal} />
    </>
  );
}

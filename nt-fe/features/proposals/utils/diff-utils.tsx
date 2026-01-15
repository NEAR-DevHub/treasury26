import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type React from "react";

/**
 * Checks if a value should be considered "null" for display purposes
 */
export const isNullValue = (val: any): boolean =>
  val === undefined || val === null || val === "" || val === "null";

/**
 * Common component for displaying a diff between two values
 */
export const renderDiff = (oldNode: React.ReactNode, newNode: React.ReactNode, isOldNull: boolean = false) => (
  <div className="flex items-center gap-2">
    <span className={cn("text-muted-foreground", !isOldNull && "line-through decoration-muted-foreground/50")}>
      {oldNode}
    </span>
    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
    <span className="font-medium text-foreground">
      {newNode}
    </span>
  </div>
);






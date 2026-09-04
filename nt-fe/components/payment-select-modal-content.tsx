"use client";

import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { DialogContent, mobileInsetSheetClassName } from "@/components/modal";
import { cn } from "@/lib/utils";

/** Desktop size for Token / Recipient / Destination pickers (~671×448). */
const contentSizeClassName =
    "max-sm:h-[80vh] max-sm:max-h-[80vh] sm:min-h-0 sm:h-168! sm:max-h-[90vh] sm:w-full! sm:max-w-md!";

/** Shared DialogContent chrome (matches network picker spacing). */
const dialogChromeClassName =
    "min-h-0 max-h-[90vh] gap-0 overflow-hidden p-4 sm:gap-4";

/**
 * Dialog shell for Send/Deposit token, network, and recipient pickers.
 * Same inset floating sheet as recent-activity details on small screens.
 */
export function PaymentSelectModalContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DialogContent>) {
    return (
        <DialogContent
            className={cn(
                mobileInsetSheetClassName,
                dialogChromeClassName,
                contentSizeClassName,
                className,
            )}
            {...props}
        >
            <div className="-mb-2 sm:hidden">
                <SheetHandle />
            </div>
            {children}
        </DialogContent>
    );
}

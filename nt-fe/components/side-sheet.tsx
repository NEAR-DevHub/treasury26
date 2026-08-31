"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef } from "react";
import { Dialog } from "@/components/modal";
import {
    DialogClose,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

/**
 * A panel that slides in from the right edge and stays inset from it, rather
 * than a centered modal. Same Radix dialog underneath — including the wallet
 * connector workaround in `components/modal` — so focus, escape and overlay
 * behaviour match every other dialog in the app.
 */
const SideSheet = Dialog;

function SideSheetContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);
    const pushed = useRef(false);
    const contentRef = useRef<HTMLDivElement>(null);

    function handleStateChange(open: boolean) {
        if (open && !pushed.current) {
            pushed.current = true;
            pushOverlay();
        } else if (!open && pushed.current) {
            pushed.current = false;
            popOverlay();
        }
    }

    return (
        <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Content
                ref={contentRef}
                data-slot="side-sheet-content"
                // The header carries the title; there is no separate blurb to
                // describe the panel, so opt out of Radix's description check.
                aria-describedby={undefined}
                {...props}
                onOpenAutoFocus={(e) => {
                    handleStateChange(true);
                    // Radix would focus the first control in the header, which
                    // reads as a hover — its tooltip pops open the moment the
                    // sheet appears. Hold focus on the panel itself instead, so
                    // the trap and escape still work but nothing looks armed.
                    e.preventDefault();
                    contentRef.current?.focus();
                    props.onOpenAutoFocus?.(e);
                }}
                onCloseAutoFocus={(e) => {
                    handleStateChange(false);
                    props.onCloseAutoFocus?.(e);
                }}
                className={cn(
                    "fixed z-50 flex flex-col overflow-hidden bg-card shadow-lg outline-none",
                    "inset-y-2 right-2 w-[448px] max-w-[calc(100vw-1rem)] rounded-3xl",
                    "max-sm:inset-x-2 max-sm:w-auto",
                    "data-[state=open]:animate-in data-[state=closed]:animate-out",
                    "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
                    "duration-300",
                    className,
                )}
            >
                {children}
            </DialogPrimitive.Content>
        </DialogPortal>
    );
}

/** Title bar: the heading on the left, a tray of icon actions on the right. */
function SideSheetHeader({
    title,
    actions,
    className,
}: {
    title: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex shrink-0 items-center justify-between gap-4 px-5 py-4",
                className,
            )}
        >
            <DialogTitle className="text-base font-semibold leading-[1.2]">
                {title}
            </DialogTitle>
            {actions && (
                <div className="flex items-center gap-1">{actions}</div>
            )}
        </div>
    );
}

/** The scrolling middle of the sheet — the header and footer stay put. */
function SideSheetBody({
    className,
    children,
}: {
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4",
                className,
            )}
        >
            {children}
        </div>
    );
}

function SideSheetFooter({
    className,
    children,
}: {
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={cn("flex shrink-0 items-center gap-4 p-4", className)}>
            {children}
        </div>
    );
}

export {
    SideSheet,
    SideSheetBody,
    SideSheetContent,
    SideSheetFooter,
    SideSheetHeader,
    DialogClose as SideSheetClose,
};

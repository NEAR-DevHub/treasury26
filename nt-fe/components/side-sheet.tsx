"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
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

/**
 * Where the body has been scrolled to. The header and footer sit outside the
 * scroll container, so content passes *behind* them; a hairline appears on
 * whichever edge is currently hiding something, the way the token modal on
 * near.com marks the same overflow.
 */
interface SideSheetScrollState {
    /** Content has moved up behind the header. */
    hasContentAbove: boolean;
    /** Content continues below the footer. */
    hasContentBelow: boolean;
}

const NOT_SCROLLED: SideSheetScrollState = {
    hasContentAbove: false,
    hasContentBelow: false,
};

const SideSheetScrollContext = createContext<{
    scroll: SideSheetScrollState;
    report: (scroll: SideSheetScrollState) => void;
}>({ scroll: NOT_SCROLLED, report: () => {} });

function SideSheetContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);
    const pushed = useRef(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const [scroll, setScroll] = useState(NOT_SCROLLED);
    const report = useCallback((next: SideSheetScrollState) => {
        setScroll((prev) =>
            prev.hasContentAbove === next.hasContentAbove &&
            prev.hasContentBelow === next.hasContentBelow
                ? prev
                : next,
        );
    }, []);

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
                    "data-[state=open]:animate-in data-[state=closed]:animate-out duration-300",
                    // Phone and tablet: a sheet rising from the bottom edge,
                    // leaving a strip of the list it came from visible above it.
                    "inset-x-0 bottom-0 top-[10dvh] rounded-t-3xl",
                    "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
                    // Desktop: a panel inset from the right edge instead. The
                    // bottom slide has to be zeroed out or it still translates.
                    "lg:inset-y-2 lg:right-2 lg:left-auto lg:w-[448px] lg:max-w-[calc(100vw-1rem)] lg:rounded-3xl",
                    "lg:data-[state=open]:slide-in-from-bottom-0 lg:data-[state=closed]:slide-out-to-bottom-0",
                    "lg:data-[state=open]:slide-in-from-right lg:data-[state=closed]:slide-out-to-right",
                    className,
                )}
            >
                {/* Every bottom-sheet in the app leads with the drag handle;
                    the desktop panel slides in from the side, so it drops. */}
                <div className="shrink-0 pt-4 lg:hidden">
                    <SheetHandle />
                </div>
                <SideSheetScrollContext.Provider value={{ scroll, report }}>
                    {children}
                </SideSheetScrollContext.Provider>
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
    const { scroll } = useContext(SideSheetScrollContext);
    return (
        <div
            className={cn(
                "flex shrink-0 items-center justify-between gap-4 border-transparent border-b px-5 py-4",
                scroll.hasContentAbove && "border-general-border",
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
    const { report } = useContext(SideSheetScrollContext);
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        if (!viewport || !content) return;

        const measure = () =>
            report({
                hasContentAbove: viewport.scrollTop > 1,
                hasContentBelow:
                    viewport.scrollHeight -
                        viewport.scrollTop -
                        viewport.clientHeight >
                    1,
            });

        measure();
        viewport.addEventListener("scroll", measure, { passive: true });
        // The body's own box never changes, so the content is what's watched —
        // a request that reveals its payload grows it mid-scroll.
        const observer = new ResizeObserver(measure);
        observer.observe(viewport);
        observer.observe(content);

        return () => {
            viewport.removeEventListener("scroll", measure);
            observer.disconnect();
        };
    }, [report]);

    return (
        <div
            ref={viewportRef}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4"
        >
            <div
                ref={contentRef}
                className={cn("flex flex-col gap-3", className)}
            >
                {children}
            </div>
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
    const { scroll } = useContext(SideSheetScrollContext);
    return (
        <div
            className={cn(
                "flex shrink-0 items-center gap-4 border-transparent border-t p-4",
                scroll.hasContentBelow && "border-general-border",
                // On a phone the sheet reaches the bottom edge, so the footer
                // owns the home-indicator inset.
                "pb-[max(1rem,env(safe-area-inset-bottom))] lg:pb-4",
                className,
            )}
        >
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

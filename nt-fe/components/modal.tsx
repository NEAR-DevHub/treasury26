import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icon";
import {
    Dialog as BaseDialog,
    DialogClose as BaseDialogClose,
    DialogContent as BaseDialogContent,
    DialogFooter as BaseDialogFooter,
    DialogHeader as BaseDialogHeader,
    DialogTitle as BaseDialogTitle,
    DialogDescription,
    DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useHasSidebarRail } from "@/components/app-shell-context";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useUiStore } from "@/stores/ui-store";

// @hot-labs/near-connect mounts its wallet popup on document.body with class
// `.hot-connector-popup`. Radix Dialog in modal mode blocks pointer events on
// body siblings, so clicks on the connector UI don't register. Instead of
// fighting Radix, we temporarily close any open Dialog while the connector
// popup is visible, then reopen it when the popup closes.
const connectorListeners = new Set<(v: boolean) => void>();
let connectorVisible = false;
let connectorObserverStarted = false;

function startConnectorObserver() {
    if (connectorObserverStarted || typeof document === "undefined") return;
    connectorObserverStarted = true;
    const check = () => {
        const visible = !!document.querySelector(".hot-connector-popup");
        if (visible === connectorVisible) return;
        connectorVisible = visible;
        connectorListeners.forEach((l) => l(visible));
    };
    check();
    new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: false,
    });
}

function useConnectorPopupVisible() {
    return useSyncExternalStore(
        (cb) => {
            startConnectorObserver();
            connectorListeners.add(cb);
            return () => connectorListeners.delete(cb);
        },
        () => connectorVisible,
        () => false,
    );
}

function Dialog({
    open,
    defaultOpen,
    onOpenChange,
    ...props
}: React.ComponentProps<typeof BaseDialog>) {
    const connectorOpen = useConnectorPopupVisible();
    const isControlled = open !== undefined;
    const [uncontrolledOpen, setUncontrolledOpen] = useState(!!defaultOpen);
    const actualOpen = isControlled ? open : uncontrolledOpen;

    // Remember whether the dialog was open at the moment the connector popup
    // appeared, so we can restore it after the popup closes.
    const suspendedOpenRef = useRef<boolean | null>(null);
    useEffect(() => {
        if (connectorOpen && suspendedOpenRef.current === null) {
            suspendedOpenRef.current = actualOpen;
        } else if (!connectorOpen && suspendedOpenRef.current !== null) {
            const restore = suspendedOpenRef.current;
            suspendedOpenRef.current = null;
            if (restore && !actualOpen) {
                if (isControlled) onOpenChange?.(true);
                else setUncontrolledOpen(true);
            }
        }
    }, [connectorOpen, actualOpen, isControlled, onOpenChange]);

    const effectiveOpen = connectorOpen ? false : actualOpen;
    const handleOpenChange = (next: boolean) => {
        if (connectorOpen) {
            // Connector-driven close: don't propagate; we'll restore later.
            return;
        }
        if (!isControlled) setUncontrolledOpen(next);
        onOpenChange?.(next);
    };

    return (
        <BaseDialog
            {...props}
            open={effectiveOpen}
            onOpenChange={handleOpenChange}
        />
    );
}

interface DialogHeaderProps
    extends React.ComponentProps<typeof BaseDialogHeader> {
    centerTitle?: boolean;
    closeButton?: boolean;
}

function DialogHeader({
    className,
    children,
    centerTitle = false,
    closeButton = true,
    ...props
}: DialogHeaderProps) {
    const t = useTranslations("common");
    return (
        <BaseDialogHeader
            {...props}
            className={cn(
                "border-b border-border -mx-4 px-4 flex flex-row items-center justify-between text-center gap-2 sticky top-0 z-10 bg-card sm:static",
                className,
            )}
        >
            <div className={cn(centerTitle && "flex-1")}>{children}</div>
            {closeButton && (
                <BaseDialogClose className="ring-offset-background focus-visible:ring-ring inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none">
                    <Icon icon={Cancel01Icon} />
                    <span className="sr-only">{t("close")}</span>
                </BaseDialogClose>
            )}
        </BaseDialogHeader>
    );
}

function DialogTitle({
    className,
    ...props
}: React.ComponentProps<typeof BaseDialogTitle>) {
    return (
        <BaseDialogTitle
            {...props}
            className={cn("text-lg font-semibold text-center", className)}
        />
    );
}

function DialogFooter({
    className,
    ...props
}: React.ComponentProps<typeof BaseDialogFooter>) {
    return (
        <BaseDialogFooter
            {...props}
            className={cn("px-4 -mx-4 pt-3 shrink-0", className)}
        />
    );
}

function DialogContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof BaseDialogContent>) {
    const pushOverlay = useUiStore((s) => s.pushOverlay);
    const popOverlay = useUiStore((s) => s.popOverlay);
    const pushed = useRef(false);
    const hasSidebarRail = useHasSidebarRail();
    const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);

    // Track open/close via the `data-state` attribute change on the content element.
    // We use onAnimationStart which fires when the open animation begins.
    function handleStateChange(open: boolean) {
        if (open && !pushed.current) {
            pushed.current = true;
            pushOverlay();
        } else if (!open && pushed.current) {
            pushed.current = false;
            popOverlay();
        }
    }

    // Only on large screens (sidebar rail). Mobile stays full-width bottom sheet.
    const contentCenterClass = hasSidebarRail
        ? isSidebarOpen
            ? "lg:left-[calc(50%+9.25rem)]!"
            : "lg:left-[calc(50%+2.5rem)]!"
        : undefined;

    return (
        <BaseDialogContent
            {...props}
            showCloseButton={false}
            onOpenAutoFocus={(e) => {
                handleStateChange(true);
                props.onOpenAutoFocus?.(e);
            }}
            onCloseAutoFocus={(e) => {
                handleStateChange(false);
                props.onCloseAutoFocus?.(e);
            }}
            className={cn(
                "bg-card flex flex-col",
                // Mobile: bottom drawer with a consistent inset
                "max-w-none! w-full inset-x-0 left-0 right-0 bottom-0 top-auto translate-x-0 translate-y-0 max-h-[80vh] rounded-t-3xl rounded-b-none",
                "p-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:gap-0 sm:gap-4",
                "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
                "data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100",
                // Desktop: centered modal
                "sm:max-w-lg! sm:inset-x-auto sm:top-[50%] sm:left-[50%] sm:bottom-auto sm:right-auto",
                "sm:w-full sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-3xl",
                "sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0",
                "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
                "overflow-y-auto scrollbar-hide",
                contentCenterClass,
                className,
            )}
        >
            {children}
        </BaseDialogContent>
    );
}

export {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogTrigger,
    DialogDescription,
    useConnectorPopupVisible,
};

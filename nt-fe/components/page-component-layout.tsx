"use client";
import { Icon } from "@/components/icon";
import {
    ArrowLeft01Icon,
    MoonIcon,
    PanelLeftIcon,
    Sun01Icon,
} from "@hugeicons/core-free-icons";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { useHasSidebarRail } from "@/components/app-shell-context";
import { useInAppHistory } from "@/hooks/use-in-app-history";
import { shouldShowPageBack } from "@/lib/in-app-navigation";
import { Button } from "@/components/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
    MobileTreasuryHeaderButton,
    MobileUserHeaderButton,
} from "@/components/mobile-shell/mobile-header-controls";
import { Pill } from "@/components/pill";
import { SignIn } from "@/components/sign-in";
import { SlotWarning } from "@/components/warning-message";
import { isStaging } from "@/constants/features";
import { cn } from "@/lib/utils";
import { useSidebarStore } from "@/stores/sidebar-store";

interface PageComponentLayoutProps {
    title: string;
    description?: string;
    /** `true` = router.back(); string = push path; function = custom handler. */
    backButton?: boolean | string | (() => void);
    /**
     * `section` — one-level pages (Send, Deposit, Swap). Back is hidden on
     * large screens and only shown on small screens after an in-app navigation.
     * `nested` — second-level pages (Bulk send). Back is always shown.
     */
    backKind?: "section" | "nested";
    hideLogin?: boolean;
    hideCollapseButton?: boolean;
    hideAppWarningBanner?: boolean;
    transparentHeader?: boolean;
    hideHeaderBottomBorder?: boolean;
    /** Renders an empty header: no logo/title, staging pill, language or theme controls. */
    hideHeaderContent?: boolean;
    /**
     * Hides the mobile treasury selector + profile controls. Use with
     * `backButton` for inner pages (Send, Bulk send, Deposit): on small
     * screens the header is back + optional `headerActions` on one row and
     * the title below; from `lg` it stays a single row.
     */
    hideMobileShellControls?: boolean;
    /** Page-specific controls pinned to the right edge of the header. */
    headerActions?: ReactNode;
    /** Drops the header entirely, so the page owns the full viewport height. */
    hideHeader?: boolean;
    /**
     * Hides the header below `lg` (e.g. Menu destinations that own an in-page
     * title row instead of the treasury/user shell bar).
     */
    hideHeaderOnMobile?: boolean;
    /**
     * Hides the stacked page heading on small screens only (keeps the top
     * back control). Large screens still show the title in the header row.
     */
    hideTitle?: boolean;
    /**
     * Pins the page to the viewport height on every breakpoint. A short viewport
     * that can't fit the content scrolls the whole page, header included.
     */
    fitViewport?: boolean;
    logo?: ReactNode;
    mainClassName?: string;
    children: ReactNode;
}

export function PageComponentLayout({
    title,
    description,
    backButton,
    backKind = "nested",
    hideCollapseButton,
    hideLogin,
    hideAppWarningBanner,
    transparentHeader = false,
    hideHeaderBottomBorder = false,
    hideHeaderContent = false,
    hideMobileShellControls = false,
    headerActions,
    hideHeader = false,
    hideHeaderOnMobile = false,
    hideTitle = false,
    fitViewport = false,
    logo,
    mainClassName,
    children,
}: PageComponentLayoutProps) {
    const { toggleSidebar } = useSidebarStore();
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const tHeader = useTranslations("header");
    const tCommon = useTranslations("common");
    // Inside the treasury shell these controls live in the sidebar profile menu.
    const hasSidebarRail = useHasSidebarRail();

    useEffect(() => {
        setMounted(true);
    }, []);

    const isDarkTheme = mounted ? resolvedTheme === "dark" : true;

    const router = useRouter();
    const cameFromApp = useInAppHistory();
    const stackedInnerHeader = hideMobileShellControls;
    const showBack = shouldShowPageBack({
        hasBackButton: !!backButton,
        backKind,
        cameFromApp,
    });
    const showMobileChromeRow =
        stackedInnerHeader && (showBack || !!headerActions);

    const handleBack = () => {
        if (typeof backButton === "function") {
            backButton();
            return;
        }
        if (backKind === "section" && cameFromApp) {
            router.back();
            return;
        }
        if (typeof backButton === "string") {
            router.push(backButton);
            return;
        }
        router.back();
    };

    const backControl = showBack ? (
        <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            aria-label={tCommon("back")}
            className={cn(
                hideMobileShellControls &&
                    "size-10 rounded-lg bg-muted text-muted-foreground hover:bg-muted hover:text-foreground lg:size-9 lg:rounded-md lg:bg-transparent",
                backKind === "section" && "lg:hidden",
            )}
        >
            <Icon icon={ArrowLeft01Icon} className="stroke-2" />
        </Button>
    ) : null;

    const titleBlock = !hideHeaderContent
        ? (logo ?? (
              <div
                  className={cn(
                      "items-baseline gap-2",
                      stackedInnerHeader
                          ? "hidden lg:flex"
                          : hideMobileShellControls
                            ? "flex"
                            : "hidden lg:flex",
                  )}
              >
                  <h1 className="text-xl font-semibold leading-tight tracking-tight">
                      {title}
                  </h1>
                  {description && (
                      <span className="hidden lg:inline text-xs text-muted-foreground">
                          {description}
                      </span>
                  )}
              </div>
          ))
        : null;

    return (
        <div
            className={cn(
                "flex h-full flex-col sm:gap-0",
                hideMobileShellControls && "gap-6 px-2",
                fitViewport && "h-dvh overflow-y-auto",
                hideHeaderContent && "bg-general-bg-tertiary",
            )}
        >
            {!hideHeader && (
                <header
                    className={cn(
                        "flex shrink-0 px-3 md:px-6",
                        stackedInnerHeader
                            ? "flex-col items-stretch gap-3 pt-[max(0.5rem,env(safe-area-inset-top))] lg:flex-row lg:items-center lg:justify-between lg:min-h-16 lg:gap-4 lg:pt-0"
                            : "items-center min-h-16 justify-between",
                        hideHeaderOnMobile && "hidden lg:flex",
                        // Onboarding / stacked mobile headers collapse the empty bar.
                        hideHeaderContent &&
                            !backButton &&
                            "min-h-0 md:min-h-16",
                        hideMobileShellControls &&
                            backButton &&
                            !stackedInnerHeader &&
                            "min-h-12 pt-[max(0.5rem,env(safe-area-inset-top))] lg:min-h-16 lg:pt-0",
                        // Inside the shell the floating panel owns the surface, so
                        // the content area must not paint over it.
                        !hasSidebarRail &&
                            !hideHeaderBottomBorder &&
                            "border-b border-border",
                        hasSidebarRail || transparentHeader
                            ? "bg-transparent"
                            : "bg-card",
                    )}
                >
                    <div
                        className={cn(
                            "flex items-center gap-2 md:gap-4",
                            stackedInnerHeader && "justify-between",
                            stackedInnerHeader &&
                                !showMobileChromeRow &&
                                "hidden lg:flex",
                        )}
                    >
                        <div className="flex items-center gap-2 md:gap-4">
                            {!hideCollapseButton && (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={toggleSidebar}
                                    className="hidden size-10 text-muted-foreground hover:bg-muted hover:text-foreground lg:inline-flex"
                                    aria-label={tHeader("toggleSidebar")}
                                >
                                    <Icon
                                        icon={PanelLeftIcon}
                                        className="size-4"
                                    />
                                </Button>
                            )}
                            {hasSidebarRail && !hideMobileShellControls && (
                                <div className="min-w-0 lg:hidden">
                                    <MobileTreasuryHeaderButton />
                                </div>
                            )}
                            <div className="flex items-center gap-2 md:gap-3">
                                {backControl}
                                {titleBlock}
                            </div>
                        </div>
                        {stackedInnerHeader && headerActions ? (
                            <div className="lg:hidden">{headerActions}</div>
                        ) : null}
                    </div>

                    {stackedInnerHeader &&
                    !hideHeaderContent &&
                    !hideTitle &&
                    !logo ? (
                        <div className="lg:hidden">
                            <h1 className="text-2xl font-semibold leading-tight tracking-tight text-general-foreground">
                                {title}
                            </h1>
                            {description ? (
                                <p className="mt-1 text-base leading-[1.5] text-general-secondary-foreground">
                                    {description}
                                </p>
                            ) : null}
                        </div>
                    ) : null}

                    <div
                        className={cn(
                            "flex items-center gap-3",
                            stackedInnerHeader && "hidden lg:flex",
                        )}
                    >
                        {headerActions}
                        {hasSidebarRail && !hideMobileShellControls && (
                            <div className="lg:hidden">
                                <MobileUserHeaderButton />
                            </div>
                        )}
                        {!hasSidebarRail && !hideHeaderContent && isStaging && (
                            <>
                                <span
                                    className="size-2 rounded-full bg-general-orange-foreground md:hidden"
                                    title="Staging"
                                    aria-label="Staging"
                                />
                                <Pill
                                    title="Staging"
                                    icon={
                                        <span className="size-1.5 rounded-full bg-general-orange-foreground" />
                                    }
                                    className="hidden md:flex bg-general-orange-background-faded text-general-orange-foreground"
                                />
                            </>
                        )}
                        {!hasSidebarRail && !hideHeaderContent && (
                            <>
                                <LanguageSwitcher />
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() =>
                                        setTheme(isDarkTheme ? "light" : "dark")
                                    }
                                    aria-label={tHeader("toggleTheme")}
                                    className="text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                    {isDarkTheme ? (
                                        <Icon icon={Sun01Icon} />
                                    ) : (
                                        <Icon icon={MoonIcon} />
                                    )}
                                </Button>

                                {!hideLogin && <SignIn />}
                            </>
                        )}
                    </div>
                </header>
            )}

            <main
                className={cn(
                    "flex-1 px-4 pb-6 md:px-6 md:pb-8",
                    // A pinned page scrolls as a whole, so the content area must
                    // keep its natural height instead of scrolling on its own.
                    !fitViewport && "overflow-y-auto",
                    // Inside the shell the floating panel owns the surface, so
                    // the content area must not paint over it.
                    hasSidebarRail
                        ? "bg-transparent"
                        : "bg-general-bg-tertiary",
                    mainClassName,
                )}
            >
                {!hideAppWarningBanner && (
                    <>
                        <SlotWarning
                            slot="data.balances"
                            className="lg:hidden mb-3"
                            headingClassName="font-medium"
                        />
                        <SlotWarning slot="app" className="lg:hidden mb-3" />
                    </>
                )}
                {children}
            </main>
        </div>
    );
}

"use client";

import { Icon } from "@/components/icon";
import {
    ArrowLeft01Icon,
    ArrowRight01Icon,
    MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/button";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface PaginationProps {
    pageIndex: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    className?: string;
}

export function Pagination({
    pageIndex,
    totalPages,
    onPageChange,
    className,
}: PaginationProps) {
    const t = useTranslations("pagination");
    const getPages = () => {
        const pages: (number | string)[] = [];

        if (totalPages <= 7) {
            for (let i = 0; i < totalPages; i++) pages.push(i);
        } else {
            pages.push(0);

            if (pageIndex > 2) {
                pages.push("...");
            }

            const start = Math.max(1, pageIndex - 1);
            const end = Math.min(totalPages - 2, pageIndex + 1);

            for (let i = start; i <= end; i++) {
                if (!pages.includes(i)) pages.push(i);
            }

            if (pageIndex < totalPages - 3) {
                pages.push("...");
            }

            if (!pages.includes(totalPages - 1)) {
                pages.push(totalPages - 1);
            }
        }
        return pages;
    };

    if (totalPages <= 1) return null;

    return (
        <div
            className={cn(
                "flex items-center justify-center sm:justify-end space-x-1",
                className,
            )}
        >
            <Button
                variant="ghost"
                onClick={() => onPageChange(pageIndex - 1)}
                disabled={pageIndex === 0}
                className="text-muted-foreground hover:text-foreground text-xs gap-1"
            >
                <Icon icon={ArrowLeft01Icon} />
                <span className="hidden sm:inline">{t("previous")}</span>
            </Button>

            <span className="sm:hidden text-sm text-muted-foreground px-1">
                {pageIndex + 1} / {totalPages}
            </span>

            <div className="hidden sm:flex items-center space-x-1">
                {getPages().map((page, i) =>
                    page === "..." ? (
                        <span
                            key={`ellipsis-${i}`}
                            className="px-2 text-muted-foreground"
                        >
                            <Icon icon={MoreHorizontalIcon} />
                        </span>
                    ) : (
                        <Button
                            key={page}
                            variant={pageIndex === page ? "outline" : "ghost"}
                            size="sm"
                            onClick={() => onPageChange(page as number)}
                            className={cn(
                                "h-9 w-9 font-normal rounded-lg",
                                pageIndex === page
                                    ? "border-border bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground hover:bg-transparent",
                            )}
                        >
                            {(page as number) + 1}
                        </Button>
                    ),
                )}
            </div>

            <Button
                variant="ghost"
                onClick={() => onPageChange(pageIndex + 1)}
                disabled={pageIndex >= totalPages - 1}
                className="text-muted-foreground hover:text-foreground text-xs gap-1"
            >
                <span className="hidden sm:inline">{t("next")}</span>
                <Icon icon={ArrowRight01Icon} />
            </Button>
        </div>
    );
}

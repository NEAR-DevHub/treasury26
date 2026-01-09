import { Button } from "@/components/button";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
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
  const getPages = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 3;

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
    <div className={cn("flex items-center justify-end space-x-1", className)}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPageChange(pageIndex - 1)}
        disabled={pageIndex === 0}
        className="text-muted-foreground hover:text-foreground gap-1 px-3"
      >
        <ChevronLeft className="h-4 w-4" />
        Previous
      </Button>

      <div className="flex items-center space-x-1">
        {getPages().map((page, i) => (
          page === "..." ? (
            <span key={`ellipsis-${i}`} className="px-2 text-muted-foreground">
              <MoreHorizontal className="h-4 w-4" />
            </span>
          ) : (
            <Button
              key={page}
              variant={pageIndex === page ? "outline" : "ghost"}
              size="sm"
              onClick={() => onPageChange(page as number)}
              className={cn(
                "h-9 w-9 p-0 font-normal rounded-lg",
                pageIndex === page
                  ? "border-border bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-transparent"
              )}
            >
              {(page as number) + 1}
            </Button>
          )
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPageChange(pageIndex + 1)}
        disabled={pageIndex >= totalPages - 1}
        className="text-muted-foreground hover:text-foreground gap-1 px-3"
      >
        Next
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}


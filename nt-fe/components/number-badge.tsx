import { cn } from "@/lib/utils";

export function NumberBadge({
  number,
  variant = "default",
  className,
}: {
  number: number;
  variant?: "default" | "secondary";
  className?: string;
}) {
  const variants = {
    default: "bg-orange-500 text-white",
    secondary: "bg-muted text-muted-foreground",
  };
  return (
    <span
      aria-label={`${number} pending requests`}
      className={cn(
        "flex size-5 items-center justify-center rounded-[8px] px-2 py-[3px] text-xs font-semibold",
        variants[variant],
        className
      )}
    >
      {number}
    </span>
  );
}

import { cn } from "@/lib/utils";

export function PageCard({ children, className, ...props }: React.ComponentProps<"div">) {
    return <div className={cn("flex flex-col gap-4 rounded-[14px] bg-card p-4", className)} {...props}>
        {children}
    </div>
}

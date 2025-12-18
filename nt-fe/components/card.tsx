import { cn } from "@/lib/utils";

export function PageCard({ children, className, ...props }: React.ComponentProps<"div">) {
    return <div className={cn("flex flex-col gap-4 rounded-[14px] border-none border bg-card p-4", className)} {...props}>
        {children}
    </div>
}

import { cn } from "@/lib/utils";

interface InputBlockProps {
    title?: string;
    topRightContent?: React.ReactNode;
    children: React.ReactNode;
    invalid: boolean;
}
export function InputBlock({ children, title, topRightContent, invalid }: InputBlockProps) {
    return (
        <div className={cn("px-3.5 py-3 rounded-xl bg-muted", invalid && "border-destructive border bg-destructive/5")} >
            <div className="flex justify-between items-center">
                {title && <p className="text-xs text-muted-foreground">
                    {title}
                </p>}
                {topRightContent}
            </div>
            {children}
        </div>
    );
}

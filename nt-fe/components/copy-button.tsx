import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./button";
import { cn } from "@/lib/utils";

interface CopyButtonProps extends React.ComponentProps<typeof Button> {
    text: string;
    toastMessage?: string;
    iconClassName?: string;
}

export function CopyButton({
    text,
    toastMessage = "Copied to clipboard",
    children,
    iconClassName,
    ...props
}: CopyButtonProps) {
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(toastMessage);
        } catch (error) {
            toast.error("Failed to copy");
        }
    };

    return (
        <Button type="button" onClick={handleCopy} {...props}>
            <Copy className={cn("h-4 w-4", iconClassName)} />
            {children}
        </Button>
    );
}

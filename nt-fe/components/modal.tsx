import {
    Dialog,
    DialogContent as BaseDialogContent,
    DialogHeader as BaseDialogHeader,
    DialogTitle as BaseDialogTitle,
    DialogTrigger,
    DialogClose as BaseDialogClose,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";

function DialogHeader({ className, children, ...props }: React.ComponentProps<typeof BaseDialogHeader>) {
    return (
        <BaseDialogHeader
            {...props}
            className={cn("border-b border-border p-4 flex flex-row items-center justify-between text-center gap-4", className)}
        >
            <div className="flex-1">
                {children}
            </div>
            <BaseDialogClose className="rounded-xs opacity-70 transition-opacity hover:opacity-100 ">
                <XIcon className="size-4" />
                <span className="sr-only">Close</span>
            </BaseDialogClose>
        </BaseDialogHeader>
    );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof BaseDialogTitle>) {
    return (
        <BaseDialogTitle
            {...props}
            className={cn("text-lg font-semibold text-center", className)}
        />
    );
}

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof BaseDialogContent>) {
    return (
        <BaseDialogContent
            {...props}
            showCloseButton={false}
            className={cn("bg-card", className)}
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
    DialogTrigger,
};

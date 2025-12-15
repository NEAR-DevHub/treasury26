import { Search } from "lucide-react";
import { Textarea as TextareaComponent } from "./ui/textarea";
import { cn } from "@/lib/utils";

interface TextareaComponentProps extends React.ComponentProps<typeof TextareaComponent> {
    borderless?: boolean;
}

export function Textarea({ className, borderless, ...props }: TextareaComponentProps) {
    return (
        <TextareaComponent
            {...props}
            className={cn(borderless && "border-none focus-visible:ring-0 focus-visible:ring-offset-0", className)}
        />
    );
}

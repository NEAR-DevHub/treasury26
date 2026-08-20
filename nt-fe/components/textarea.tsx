import { Textarea as TextareaComponent } from "./ui/textarea";
import { cn } from "@/lib/utils";

interface TextareaComponentProps
    extends React.ComponentProps<typeof TextareaComponent> {
    borderless?: boolean;
}

export function Textarea({
    className,
    borderless,
    ...props
}: TextareaComponentProps) {
    return (
        <TextareaComponent
            {...props}
            className={cn(
                "bg-muted! hover:bg-general-tertiary! focus-within:bg-general-tertiary! transition-colors",
                borderless &&
                    "border-none focus-visible:ring-0 focus-visible:ring-offset-0",
                className,
            )}
        />
    );
}

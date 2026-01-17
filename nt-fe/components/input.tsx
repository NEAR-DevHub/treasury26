import { cn } from "@/lib/utils";
import { Input as ShadcnInput } from "./ui/input";
import { Search, XIcon } from "lucide-react";

interface InputProps extends React.ComponentProps<typeof ShadcnInput> {
    clearable?: boolean;
    search?: boolean;
}

export function Input({ className, value, onChange, clearable = true, search, ...props }: InputProps) {
    const showClear = clearable && value && onChange;

    const handleClear = () => {
        onChange?.({ target: { value: "" } } as React.ChangeEvent<HTMLInputElement>);
    };

    return (
        <div className="relative">
            {search && (
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            )}
            <ShadcnInput
                value={value}
                onChange={onChange}
                className={cn(search && "pl-8", showClear && "pr-8", className)}
                {...props}
            />
            {showClear && (
                <button
                    type="button"
                    onClick={handleClear}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                    <XIcon className="size-4" />
                </button>
            )}
        </div>
    );
}

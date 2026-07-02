"use client";

import { cn } from "@/lib/utils";
import { Input as ShadcnInput } from "./ui/input";
import { Search, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { useState, useRef, useEffect, useCallback } from "react";

interface InputProps extends React.ComponentProps<typeof ShadcnInput> {
    clearable?: boolean;
    search?: boolean;
    showAlwaysClear?: boolean;
    onClear?: () => void;
}

export function Input({
    className,
    value,
    onChange,
    clearable = true,
    search,
    showAlwaysClear,
    onClear,
    ...props
}: InputProps) {
    const showClear = (clearable && value && onChange) || showAlwaysClear;

    const handleClear = () => {
        onChange?.({
            target: { value: "" },
        } as React.ChangeEvent<HTMLInputElement>);
        onClear?.();
    };

    return (
        <div className={cn("relative w-full", className)}>
            {search && (
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            )}
            <ShadcnInput
                value={value}
                onChange={onChange}
                autoComplete="off"
                autoCorrect="off"
                className={cn(
                    "bg-muted! border-0",
                    !props.disabled &&
                        "hover:bg-general-unofficial-ghost-hover! transition-colors",
                    search && "pl-8",
                    showClear && "pr-8",
                    className,
                )}
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

interface ResponsiveInputProps extends InputProps {
    /** Debounce delay in ms for URL/state updates. Default: 0 (no debounce). */
    debounceMs?: number;
    onDebouncedChange?: (value: string) => void;
    /** Icon shown on the collapsed mobile button and inside the desktop input. Defaults to Search. */
    icon?: React.ElementType;
    /** Placeholder text for the mobile expanded input. Falls back to `placeholder` if not provided. */
    mobilePlaceholder?: string;
    /** Called when the mobile search input expands/collapses. */
    onSearchActiveChange?: (active: boolean) => void;
}

/**
 * On md+ screens: renders a standard visible Input.
 * On small screens: renders an icon button that expands into an Input when clicked.
 */
export function ResponsiveInput({
    value,
    onChange,
    onDebouncedChange,
    debounceMs = 0,
    className,
    placeholder,
    mobilePlaceholder,
    search: _search,
    icon: Icon = Search,
    onSearchActiveChange,
    ...props
}: ResponsiveInputProps) {
    const t = useTranslations("input");
    const [isOpen, setIsOpen] = useState(false);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Open if there's already a value
    useEffect(() => {
        if (value) setIsOpen(true);
    }, []);

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            onChange?.(e);
            if (onDebouncedChange) {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                timeoutRef.current = setTimeout(
                    () => onDebouncedChange(e.target.value),
                    debounceMs,
                );
            }
        },
        [onChange, onDebouncedChange, debounceMs],
    );

    const handleClose = useCallback(() => {
        setIsOpen(false);
        onSearchActiveChange?.(false);
        onChange?.({
            target: { value: "" },
        } as React.ChangeEvent<HTMLInputElement>);
        onDebouncedChange?.("");
    }, [onChange, onDebouncedChange, onSearchActiveChange]);

    useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, []);

    const isSearchIcon = Icon === Search;

    return (
        <>
            {/* Desktop: always visible */}
            <Input
                value={value}
                onChange={handleChange}
                placeholder={placeholder}
                className={cn("w-full hidden md:flex", className)}
                search={isSearchIcon}
                {...props}
            />

            {/* Mobile: collapsed icon button */}
            {!isOpen && (
                <Button
                    variant="secondary"
                    size="icon"
                    aria-label={t("openSearch")}
                    className="flex md:hidden"
                    onClick={() => {
                        setIsOpen(true);
                        onSearchActiveChange?.(true);
                    }}
                >
                    <Icon className="size-4" />
                </Button>
            )}

            {/* Mobile: expanded input inline — X inside the input closes it */}
            {isOpen && (
                <Input
                    value={value}
                    onChange={handleChange}
                    placeholder={mobilePlaceholder ?? placeholder}
                    className={cn(
                        "flex md:hidden flex-1 min-w-0 animate-in fade-in slide-in-from-right-4 duration-200 w-full placeholder:text-xs",
                        className,
                    )}
                    search={isSearchIcon}
                    showAlwaysClear
                    onClear={handleClose}
                    autoFocus
                    {...props}
                />
            )}
        </>
    );
}

"use client";

import { forwardRef } from "react";
import { formatShortAddress } from "@/lib/format-short-address";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

interface AddressProps extends React.HTMLAttributes<HTMLDivElement> {
    address: string;
    copyable?: boolean;
    prefixLength?: number;
    suffixLength?: number;
}

export const Address = forwardRef<HTMLDivElement, AddressProps>(
    function Address(
        {
            address,
            className,
            copyable = false,
            prefixLength = 8,
            suffixLength = 8,
            ...props
        },
        ref,
    ) {
        const displayedAddress = formatShortAddress(
            address,
            prefixLength,
            suffixLength,
        );
        return (
            <div
                ref={ref}
                className={cn("flex items-center gap-2", className)}
                {...props}
            >
                <span>{displayedAddress}</span>
                {copyable && (
                    <CopyButton text={address} variant="ghost" size="icon-sm" />
                )}
            </div>
        );
    },
);

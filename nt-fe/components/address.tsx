"use client";

import { forwardRef } from "react";
import { useTranslations } from "next-intl";
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
        const t = useTranslations("address");
        const prefix = address.slice(0, prefixLength);
        const suffix = address.slice(address.length - suffixLength);
        const displayedAddress =
            address.length > prefixLength + suffixLength
                ? `${prefix}...${suffix}`
                : address;
        return (
            <div
                ref={ref}
                className={cn("flex items-center gap-2", className)}
                {...props}
            >
                <span>{displayedAddress}</span>
                {copyable && (
                    <CopyButton
                        text={address}
                        toastMessage={t("copied")}
                        variant="ghost"
                        size="icon-sm"
                    />
                )}
            </div>
        );
    },
);

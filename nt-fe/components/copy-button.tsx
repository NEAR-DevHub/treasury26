"use client";
import { Icon } from "@/components/icon";
import { Copy01Icon, CheckIcon } from "@hugeicons/core-free-icons";
import { type IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./button";

const COPIED_RESET_MS = 2000;

interface CopyButtonProps extends React.ComponentProps<typeof Button> {
    text: string;
    iconClassName?: string;
    icon?: IconSvgElement;
}

export function CopyButton({
    text,
    children,
    iconClassName,
    icon = Copy01Icon,
    ...props
}: CopyButtonProps) {
    const t = useTranslations("copyButton");
    const [copied, setCopied] = useState(false);
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasLabel = Boolean(children);

    useEffect(() => {
        return () => {
            if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        };
    }, []);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
            resetTimerRef.current = setTimeout(() => {
                setCopied(false);
                resetTimerRef.current = null;
            }, COPIED_RESET_MS);
        } catch {
            toast.error(t("failed"));
        }
    };

    return (
        <Button type="button" onClick={handleCopy} {...props}>
            <Icon icon={copied ? CheckIcon : icon} className={iconClassName} />
            {copied ? (hasLabel ? t("copied") : null) : children}
        </Button>
    );
}

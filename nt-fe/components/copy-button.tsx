"use client";
import { Icon } from "@/components/icon";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
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
    toastMessage,
    children,
    iconClassName,
    ...props
}: CopyButtonProps) {
    const t = useTranslations("copyButton");
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(toastMessage ?? t("copied"));
        } catch (error) {
            toast.error(t("failed"));
        }
    };

    return (
        <Button type="button" onClick={handleCopy} {...props}>
            <Icon icon={Copy01Icon} className={iconClassName} />
            {children}
        </Button>
    );
}

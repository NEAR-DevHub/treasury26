import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./button";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  toastMessage?: string;
  variant?: "ghost" | "outline" | "default" | "secondary" | "destructive" | "link" | "unstyled";
  size?: "default" | "sm" | "lg" | "icon" | "icon-sm";
  className?: string;
  iconClassName?: string;
  children?: React.ReactNode;
}

export function CopyButton({
  text,
  toastMessage = "Copied to clipboard",
  variant = "ghost",
  size = "icon",
  className,
  children,
  iconClassName,
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
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={handleCopy}
    >
      <Copy className={cn("h-4 w-4", iconClassName)} />
      {children}
    </Button>
  );
}


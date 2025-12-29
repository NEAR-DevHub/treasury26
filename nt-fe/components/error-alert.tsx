import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface ErrorAlertProps {
  message: string;
  className?: string;
}

export function ErrorAlert({ message, className }: ErrorAlertProps) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertTriangle className="shrink-0 mt-0.5" />
      <AlertDescription className="text-general-error-foreground">{message}</AlertDescription>
    </Alert>
  );
}


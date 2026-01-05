import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/alert";

interface WarningAlertProps {
  message: string | React.ReactNode;
  className?: string;
}

export function WarningAlert({ message, className }: WarningAlertProps) {
  return (
    <Alert variant="warning" className={className}>
      <AlertTriangle className="shrink-0 mt-0.5" />
      <AlertDescription className="text-general-warning-foreground">{message}</AlertDescription>
    </Alert>
  );
}


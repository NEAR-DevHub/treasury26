import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/alert";

interface WarningAlertProps {
  message: string | React.ReactNode;
  className?: string;
}

export function WarningAlert({ message, className }: WarningAlertProps) {
  return (
    <Alert variant="warning" className={className}>
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}


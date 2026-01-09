import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/alert";

interface InfoAlertProps {
  message: React.ReactNode;
  className?: string;
}

export function InfoAlert({ message, className }: InfoAlertProps) {
  return (
    <Alert variant="info" className={className}>
      <Info className="h-4 w-4" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}


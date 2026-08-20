import { Icon } from "@/components/icon";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/alert";

interface InfoAlertProps {
    message: React.ReactNode;
    className?: string;
}

export function InfoAlert({ message, className }: InfoAlertProps) {
    return (
        <Alert variant="info" className={className}>
            <Icon icon={InformationCircleIcon} className="shrink-0" />
            <AlertDescription>{message}</AlertDescription>
        </Alert>
    );
}

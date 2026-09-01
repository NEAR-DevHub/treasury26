import { Icon } from "@/components/icon";
import { InfoIcon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/alert";

interface InfoAlertProps {
    message: React.ReactNode;
    className?: string;
}

export function InfoAlert({ message, className }: InfoAlertProps) {
    return (
        <Alert variant="info" className={className}>
            <Icon
                icon={InfoIcon}
                className="size-4 shrink-0 text-card! [&_circle]:fill-general-info-icon [&_circle]:stroke-general-info-icon"
            />
            <AlertDescription>{message}</AlertDescription>
        </Alert>
    );
}

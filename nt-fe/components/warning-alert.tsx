import { Icon } from "@/components/icon";
import { Alert01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert";

interface WarningAlertProps {
    message: string | React.ReactNode;
    title?: string;
    className?: string;
}

export function WarningAlert({ title, message, className }: WarningAlertProps) {
    return (
        <Alert variant="warning" className={className}>
            <Icon icon={Alert01Icon} className="shrink-0" />
            <div className="flex flex-col">
                {title && <AlertTitle>{title}</AlertTitle>}
                <AlertDescription>{message}</AlertDescription>
            </div>
        </Alert>
    );
}

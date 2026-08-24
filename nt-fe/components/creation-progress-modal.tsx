"use client";
import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    LoaderCircleIcon,
    Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";

export interface CreationStep {
    id: string;
    label: string;
    status: "pending" | "in_progress" | "completed" | "error";
}

interface CreationProgressModalProps {
    open: boolean;
    steps: CreationStep[];
    error?: string | null;
    treasuryId?: string | null;
    onClose: () => void;
}

/** All four states share the same 20px ring so the rows never shift. */
const stepBadgeClassName =
    "flex size-5 shrink-0 items-center justify-center rounded-full border";

function StepStatusIcon({ status }: { status: CreationStep["status"] }) {
    switch (status) {
        case "completed":
            return (
                <div
                    className={cn(
                        stepBadgeClassName,
                        "border-green-100 bg-general-success-background-faded",
                    )}
                >
                    <Icon
                        icon={Tick02Icon}
                        className="size-2.5 text-green-700"
                    />
                </div>
            );
        case "in_progress":
            return (
                <div
                    className={cn(
                        stepBadgeClassName,
                        "border-general-orange-background bg-general-orange-background-faded",
                    )}
                >
                    <Icon
                        icon={LoaderCircleIcon}
                        className="size-2.5 animate-spin text-general-orange-foreground"
                    />
                </div>
            );
        case "error":
            return (
                <div
                    className={cn(
                        stepBadgeClassName,
                        "border-general-destructive-foreground/20 bg-general-destructive-background-faded",
                    )}
                >
                    <Icon
                        icon={Cancel01Icon}
                        className="size-2.5 text-general-destructive-foreground"
                    />
                </div>
            );
        default:
            return (
                <div
                    className={cn(stepBadgeClassName, "border-general-border")}
                />
            );
    }
}

export function CreationProgressModal({
    open,
    steps,
    error,
    treasuryId,
    onClose,
}: CreationProgressModalProps) {
    const t = useTranslations("progressModal");
    const isDone = !!treasuryId;
    const hasError = !!error;

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && (hasError || isDone)) {
                    onClose();
                }
            }}
        >
            <DialogContent
                // On a phone the sheet floats 8px off every edge with all four
                // corners rounded, rather than sitting flush to the bottom.
                className="gap-0 bg-general-tertiary p-0 right-2 bottom-2 left-2 w-auto rounded-3xl sm:right-auto sm:bottom-auto sm:left-1/2 sm:w-full sm:max-w-md! dark:bg-general-unofficial-accent"
            >
                <DialogHeader
                    closeButton={hasError || isDone}
                    className="mx-0 border-b-0 bg-transparent px-5 py-4 dark:bg-transparent"
                >
                    <DialogTitle className="text-left text-base leading-[1.2] font-semibold">
                        {hasError
                            ? t("titleFailed")
                            : isDone
                              ? t("titleDone")
                              : t("titleCreating")}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col px-5 pt-2 pb-5">
                    {steps.map((step) => (
                        <div
                            key={step.id}
                            className="flex items-center gap-3 py-2"
                        >
                            <StepStatusIcon status={step.status} />
                            <span
                                className={cn(
                                    "text-base leading-[1.2] font-semibold",
                                    step.status === "pending" &&
                                        "text-general-muted-foreground",
                                    // The active row fades out to the right,
                                    // reading as "still working on this".
                                    step.status === "in_progress" &&
                                        "bg-gradient-to-r from-general-foreground to-general-muted-foreground bg-clip-text text-transparent",
                                    step.status === "completed" &&
                                        "text-general-foreground",
                                    step.status === "error" &&
                                        "text-general-destructive-foreground",
                                )}
                            >
                                {step.label}
                            </span>
                        </div>
                    ))}
                </div>

                {hasError && (
                    <p className="px-5 pb-5 text-sm text-general-destructive-foreground">
                        {error}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
}

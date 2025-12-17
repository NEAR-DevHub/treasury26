import { useState, } from "react";
import { Control, FieldValues, Path, } from "react-hook-form";
import { Button } from "./ui/button";
import { ArrowLeftIcon, Loader2 } from "lucide-react";
import { FormDescription, FormField, FormLabel } from "./ui/form";
import { Switch } from "./ui/switch";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { getApproversAndThreshold, ProposalPermissionKind } from "@/lib/config-utils";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
export interface StepProps {
    handleBack?: () => void;
}

interface Step {
    nextButton: React.ComponentType<{ handleNext: () => void }>;
    component: React.ComponentType<{ handleBack?: () => void }>;
}

interface StepIndicatorProps {
    steps: string[];
    currentStep: number;
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
    return (
        <div className="w-full">
            <div className="flex items-center justify-start gap-6">
                {steps.map((step, index) => (
                    <button
                        key={index}
                        type="button"
                        disabled
                        className={cn(
                            "w-full font-semibold inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm",
                            "whitespace-nowrap transition-all duration-300 ease-in-out",
                            "pb-2 relative border-none bg-transparent shadow-none",
                            "after:content-[''] after:absolute after:bottom-0 after:left-0 after:right-0",
                            "after:transition-all after:duration-300 after:ease-in-out",
                            index === currentStep
                                ? 'text-foreground after:bg-primary after:h-[3px]'
                                : 'text-muted-foreground after:bg-border after:h-[2px]'

                        )}
                    >
                        {step}
                    </button>
                ))}
            </div>
        </div>
    );
}

interface StepWizardProps {
    steps: Step[];
    stepTitles?: string[];
}

export function StepWizard({
    steps,
    stepTitles,
}: StepWizardProps) {
    const [index, setIndex] = useState(0);
    const [direction, setDirection] = useState<1 | -1>(1);

    const CurrentStep = steps[index];

    // Handle next step (validate current step)
    const handleNext = async () => {
        setDirection(1);
        setIndex((i) => i + 1);
    };

    const handleBack = () => {
        setDirection(-1);
        setIndex((i) => i - 1);
    };

    const variants = {
        enter: (direction: number) => ({
            x: direction > 0 ? '100%' : '-100%',
            opacity: 0,
        }),
        center: {
            x: 0,
            opacity: 1,
        },
        exit: (direction: number) => ({
            x: direction > 0 ? '-100%' : '100%',
            opacity: 0,
        }),
    };

    return (
        <div className="relative overflow-hidden flex flex-col gap-6">
            {stepTitles && stepTitles.length > 0 && (
                <StepIndicator steps={stepTitles} currentStep={index} />
            )}
            <AnimatePresence initial={false} custom={direction} mode="popLayout">
                <motion.div
                    key={index}
                    custom={direction}
                    variants={variants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{
                        x: { type: "tween", duration: 0.25, ease: "easeInOut" },
                        opacity: { duration: 0.20 },
                    }}
                    className="flex flex-col gap-4"
                >
                    <CurrentStep.component handleBack={index > 0 ? handleBack : undefined} />
                    <CurrentStep.nextButton handleNext={handleNext} />
                </motion.div>
            </AnimatePresence>
        </div>
    );
}

interface HandleBackWithTitleProps {
    title: string;
    handleBack?: () => void;
}

export function StepperHeader({ title, handleBack }: HandleBackWithTitleProps) {
    return (
        <div className="flex items-center gap-2">
            {
                handleBack && <Button variant={'ghost'} size={'icon'} type="button" onClick={handleBack}>{<ArrowLeftIcon className="size-4" />}</Button>
            }
            <p className="text-lg font-semibold">{title}</p>
        </div>
    );
}

export const StepperNextButton = ({ text, loading = false }: { text: string; loading?: boolean }) => {
    return (handleNext?: () => void) => {
        const { type, onClick } = handleNext ? { type: "button" as const, onClick: handleNext } : { type: "submit" as const, onClick: undefined };
        return (
            <Button className="w-full h-13 font-semibold text-lg" type={type} onClick={onClick} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
                {text}
            </Button>
        );
    }
};

interface ReviewStepProps<TFieldValues extends FieldValues = FieldValues> {
    control: Control<TFieldValues>;
    reviewingTitle: string;
    children: React.ReactNode;
    approveWithMyVoteName: Path<TFieldValues>;
    proposalKind: ProposalPermissionKind;
    handleBack?: () => void;
}

export function ReviewStep<TFieldValues extends FieldValues = FieldValues>({ control, reviewingTitle, children, approveWithMyVoteName, proposalKind, handleBack }: ReviewStepProps<TFieldValues>) {
    const { selectedTreasury } = useTreasury();
    const { accountId } = useNear();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);

    const { approverAccounts } = policy ? getApproversAndThreshold(policy, accountId ?? "", proposalKind, false) : { approverAccounts: [] as string[] };

    return (
        <div className="flex flex-col gap-4">
            <StepperHeader title={reviewingTitle} handleBack={handleBack} />
            {children}
            {approverAccounts.includes(accountId ?? "") && (
                <FormField control={control} name={approveWithMyVoteName} render={({ field }) => (
                    <div className="flex items-center gap-4">
                        <Switch id="approveWithMyVote" checked={field.value} onCheckedChange={field.onChange} />
                        <div className="flex flex-col gap-1">
                            <FormLabel htmlFor="approveWithMyVote" className="font-semibold">Approve with my vote</FormLabel>
                            <FormDescription className="text-xs">This will count as the first approval for this payment request</FormDescription>
                        </div>
                    </div>
                )} />
            )}
        </div>
    );
}

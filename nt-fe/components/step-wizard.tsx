import { useState, } from "react";
import { Control, FieldValues, Path, } from "react-hook-form";
import { Button } from "./ui/button";
import { ArrowLeftIcon } from "lucide-react";
import { FormDescription, FormField, FormLabel } from "./ui/form";
import { Switch } from "./ui/switch";
import { motion, AnimatePresence } from "motion/react";

interface Step {
    nextButton: React.ComponentType<{ handleNext: () => void }>;
    component: React.ComponentType<{ handleBack?: () => void }>;
}

interface StepWizardProps {
    steps: Step[];
}

export function StepWizard({
    steps,
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
        <div className="relative overflow-hidden">
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

export const StepperNextButton = ({ text }: { text: string }) => {
    return (handleNext?: () => void) => {
        const { type, onClick } = handleNext ? { type: "button" as const, onClick: handleNext } : { type: "submit" as const, onClick: undefined };
        return <Button className="w-full h-13 font-semibold text-lg" type={type} onClick={onClick}>{text}</ Button>;
    }
};

interface ReviewStepProps<TFieldValues extends FieldValues = FieldValues> {
    control: Control<TFieldValues>;
    reviewingTitle: string;
    children: React.ReactNode;
    approveWithMyVoteName: Path<TFieldValues>;
    handleBack?: () => void;
}

export function ReviewStep<TFieldValues extends FieldValues = FieldValues>({ control, reviewingTitle, children, approveWithMyVoteName, handleBack }: ReviewStepProps<TFieldValues>) {
    return (
        <div className="flex flex-col gap-4">
            <StepperHeader title={reviewingTitle} handleBack={handleBack} />
            {children}

            <FormField control={control} name={approveWithMyVoteName} render={({ field }) => (
                <div className="flex items-start gap-2">
                    <Switch id="approveWithMyVote" checked={field.value} onCheckedChange={field.onChange} />
                    <div className="flex flex-col gap-1">
                        <FormLabel htmlFor="approveWithMyVote" className="font-semibold">Approve with my vote</FormLabel>
                        <FormDescription className="text-xs">This will count as the first approval for this payment request</FormDescription>
                    </div>
                </div>
            )} />
        </div>
    );
}

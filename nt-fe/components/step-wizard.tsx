import { useState, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { ArrowLeftIcon, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
export interface StepProps {
    handleBack?: () => void;
    handleNext?: () => void;
}

export interface StepDefinition<
    TProps extends Record<string, unknown> = Record<string, unknown>,
> {
    component: React.ComponentType<StepProps & TProps>;
    props?: TProps;
}

interface StepIndicatorProps {
    steps: string[];
    currentStep: number;
    stepLabelClassName?: string;
}

export function StepIndicator({
    steps,
    currentStep,
    stepLabelClassName,
}: StepIndicatorProps) {
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
                            "after:transition-all after:duration-300 after:ease-in-out after:rounded-full",
                            index <= currentStep
                                ? "text-foreground after:bg-foreground after:h-[3px]"
                                : "text-muted-foreground after:bg-muted-foreground/20 after:h-[3px]",
                        )}
                    >
                        <span className={cn(stepLabelClassName)}>{step}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

interface StepWizardProps {
    steps: Array<StepDefinition<any>>;
    stepTitles?: string[];
    step: number;
    onStepChange: (step: number) => void;
    stepLabelClassName?: string;
}

export function StepWizard({
    steps,
    stepTitles,
    step,
    onStepChange,
    stepLabelClassName,
}: StepWizardProps) {
    const [direction, setDirection] = useState<1 | -1>(1);
    const isTransitioningRef = useRef(false);

    const CurrentStep = steps[step];

    // Handle next step (validate current step)
    const handleNext = async () => {
        if (isTransitioningRef.current || step >= steps.length - 1) return;
        isTransitioningRef.current = true;
        setDirection(1);
        onStepChange(Math.min(step + 1, steps.length - 1));
    };

    const handleBack = () => {
        if (isTransitioningRef.current || step <= 0) return;
        isTransitioningRef.current = true;
        setDirection(-1);
        onStepChange(Math.max(step - 1, 0));
    };

    const variants = {
        enter: (direction: number) => ({
            x: direction > 0 ? "100%" : "-100%",
            opacity: 0,
        }),
        center: {
            x: 0,
            opacity: 1,
        },
        exit: (direction: number) => ({
            x: direction > 0 ? "-100%" : "100%",
            opacity: 0,
        }),
    };

    return (
        <div className="relative overflow-hidden flex flex-col gap-6">
            {stepTitles && stepTitles.length > 0 && (
                <StepIndicator
                    steps={stepTitles}
                    currentStep={step}
                    stepLabelClassName={stepLabelClassName}
                />
            )}
            <AnimatePresence
                initial={false}
                custom={direction}
                mode="popLayout"
            >
                <motion.div
                    key={step}
                    custom={direction}
                    variants={variants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{
                        x: { type: "tween", duration: 0.25, ease: "easeInOut" },
                        opacity: { duration: 0.2 },
                    }}
                    onAnimationComplete={() => {
                        isTransitioningRef.current = false;
                    }}
                    className="flex flex-col gap-4"
                >
                    <CurrentStep.component
                        {...CurrentStep.props}
                        handleBack={step > 0 ? handleBack : undefined}
                        handleNext={handleNext}
                    />
                </motion.div>
            </AnimatePresence>
        </div>
    );
}

interface HandleBackWithTitleProps {
    title: ReactNode;
    description?: ReactNode;
    handleBack?: () => void;
}

export function StepperHeader({
    title,
    description,
    handleBack,
}: HandleBackWithTitleProps) {
    return (
        <div className="flex items-center gap-2">
            {handleBack && (
                <Button
                    variant={"ghost"}
                    size={"icon"}
                    type="button"
                    onClick={handleBack}
                >
                    {<ArrowLeftIcon className="size-4" />}
                </Button>
            )}
            <div className="flex flex-col gap-0">
                <p className="font-semibold text-sm md:text-base">{title}</p>
                {description && (
                    <p className="text-sm text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
        </div>
    );
}
interface InlineNextButtonProps {
    handleNext?: () => void;
    text: string;
    loading?: boolean;
    onClick?: () => void;
}

export function InlineNextButton({
    handleNext,
    text,
    loading = false,
    onClick,
}: InlineNextButtonProps) {
    const handleClick = () => {
        if (onClick) {
            onClick();
        } else if (handleNext) {
            handleNext();
        }
    };

    const { type, onClickHandler } =
        handleNext || onClick
            ? { type: "button" as const, onClickHandler: handleClick }
            : { type: "submit" as const, onClickHandler: undefined };

    return (
        <div className="rounded-lg border bg-card p-0 overflow-hidden">
            <Button
                className="w-full"
                type={type}
                onClick={onClickHandler}
                disabled={loading}
            >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {text}
            </Button>
        </div>
    );
}

interface ReviewStepProps {
    reviewingTitle: string;
    children: React.ReactNode;
    handleBack?: () => void;
}

export function ReviewStep({
    reviewingTitle,
    children,
    handleBack,
}: ReviewStepProps) {
    return (
        <div className="flex flex-col gap-4">
            <StepperHeader title={reviewingTitle} handleBack={handleBack} />
            {children}
        </div>
    );
}

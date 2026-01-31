"use client";

import { useMemo, } from "react";
import { useRouter, useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ArrowDownToLine, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/button";
import { StepIcon } from "@/features/proposals/components/expanded-view/common/proposal-sidebar";
import { useTreasury } from "@/stores/treasury-store";
import { useAssets } from "@/hooks/use-assets";
import { TreasuryAsset } from "@/lib/api";
import Big from "big.js";
import { useProposals } from "@/hooks/use-proposals";
import { SparklesCore } from "@/components/ui/sparkles";
import { useIsGuestTreasury } from "@/hooks/use-is-guest-treasury";
import { availableBalance } from "@/lib/balance";

export type OnboardingStep = {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  active?: boolean;
  action?: {
    label: string;
    icon: "deposit" | "send";
    onClick: () => void;
  };
};

interface OnboardingProgressProps {
  className?: string;
  onDepositClick?: () => void;
}


const PROGRESS_ARC_PATH = "M159.809 108.299C160.333 108.473 160.9 108.191 161.068 107.665C164.987 95.4313 165.995 82.4472 164.008 69.7471C161.97 56.7175 156.837 44.3665 149.041 33.7295C141.245 23.0925 131.012 14.4796 119.201 8.61278C107.389 2.74597 94.3435 -0.203743 81.1571 0.0109305C67.9707 0.225604 55.0279 3.59841 43.4138 9.84658C31.7997 16.0948 21.8528 25.0362 14.4069 35.9213C6.96096 46.8064 2.23313 59.318 0.619707 72.4071C-0.952916 85.1652 0.478036 98.1095 4.79238 110.209C4.97788 110.729 5.55383 110.993 6.07175 110.801L21.2167 105.193C21.7347 105.001 21.9983 104.426 21.8145 103.906C18.5067 94.5277 17.4157 84.506 18.6334 74.6275C19.8918 64.418 23.5796 54.659 29.3874 46.1686C35.1951 37.6782 42.9538 30.7039 52.0128 25.8303C61.0718 20.9568 71.1671 18.326 81.4525 18.1585C91.7379 17.9911 101.914 20.2919 111.126 24.868C120.339 29.4441 128.321 36.1622 134.402 44.459C140.483 52.7558 144.486 62.3896 146.077 72.5527C147.615 82.3864 146.851 92.4382 143.85 101.919C143.683 102.445 143.966 103.012 144.489 103.186L159.809 108.299Z";

function SemiCircleProgress({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  const progress = current / total;
  const arcLength = 440; // 2 * PI * 70 (approx circumference)
  const dashArray = 220; // Half circle

  return (
    <div className="relative flex items-center justify-center w-[165px] h-[111px]">
      <svg
        width="165"
        height="111"
        viewBox="0 0 165 111"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <mask id="progress-mask">
            <circle
              cx="82.5"
              cy="88.8"
              r="70"
              fill="none"
              stroke="white"
              strokeWidth="120"
              strokeDasharray={`${dashArray} ${arcLength - dashArray}`}
              strokeDashoffset={dashArray * (1 - progress)}
              transform="rotate(180 82.5 88.8)"
              className="transition-[stroke-dashoffset] duration-1000 ease-in-out"
            />
          </mask>
          <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgb(168, 220, 255)" />
            <stop offset="100%" stopColor="rgb(212, 238, 255)" />
          </linearGradient>
          <clipPath id="svg-draw">
            <path d={PROGRESS_ARC_PATH} />
          </clipPath>
        </defs>

        {/* Background Arc */}
        <path d={PROGRESS_ARC_PATH} fill="#EFF6FF" fillOpacity="0.38" />
        <path clipPath="url(#svg-draw)" d={PROGRESS_ARC_PATH} fill="url(#progress-gradient)" mask="url(#progress-mask)" />


        <foreignObject clipPath="url(#svg-draw)" mask="url(#progress-mask)" x="0" y="0" width="100%" height="100%">
          <SparklesCore
            background="transparent"
            minSize={0.4}
            maxSize={1}
            particleDensity={1200}
            className="absolute inset-0 z-10"
            particleColor="#FFFFFF"
          />
        </foreignObject>

      </svg>



      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-white text-base font-bold z-10">
        {current}/{total}
      </span>
    </div>
  );
}

function StepCard({
  step,
  index,
}: {
  step: OnboardingStep;
  index: number;
}) {
  const isCompleted = step.completed;
  const isActive = step.active;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 lg:flex-row lg:items-center items-start p-3 rounded-[10.5px] w-full",
        isActive
          ? "bg-background border border-general-success"
          : "bg-general-tertiary/55"
      )}
    >
      <div className="flex flex-1 gap-3 items-start">

        <div className="pt-0.5">
          <StepIcon status={isCompleted ? "Success" : "Pending"} size="sm" />
        </div>
        <div className={cn("flex flex-col gap-0.5 flex-1 min-w-0",
          "text-xs tracking-wide",
          isCompleted || !isActive
            ? "text-muted-foreground"
            : "text-foreground"
        )}>
          <p className="text-sm font-semibold">{index + 1}. {step.title}</p>
          <span

          >
            {step.description}
          </span>
        </div>
      </div>

      {
        step.action && !isCompleted && (
          <Button
            variant="outline"
            className={cn("w-full lg:w-24 border-sidebar-border!", !isActive && "bg-card!")}
            onClick={step.action.onClick}
          >
            {step.action.icon === "deposit" ? (
              <ArrowDownToLine className="size-3.5" />
            ) : (
              <ArrowUpRight className="size-3.5" />
            )}
            {step.action.label}
          </Button>
        )
      }
    </div >
  );
}

function GradientOverlay() {
  return (
    <svg
      className="absolute w-full h-full"
      viewBox="0 0 774 238"
      fill="none"
      preserveAspectRatio="xMidYMid slice"
    >
      <g opacity="0.5" filter="url(#filter0_onboarding)">
        <path fillRule="evenodd" clipRule="evenodd" d="M565.164 333.615C481.035 336.073 405.081 318.768 364.686 283.055C332.2 254.334 328.628 218.941 349.072 184.429C349.072 184.429 282.7 -21.5366 544.738 150.693C806.777 322.923 659.667 53.3832 659.667 53.3832C745.991 49.9861 824.403 67.2582 865.683 103.753C914.021 146.488 898.341 203.998 834.783 251.394L699.973 292.504L565.164 333.615Z" fill="url(#paint0_onboarding)" />
        <path fillRule="evenodd" clipRule="evenodd" d="M565.164 333.615C481.035 336.073 405.081 318.768 364.686 283.055C332.2 254.334 328.628 218.941 349.072 184.429C349.072 184.429 282.7 -21.5366 544.738 150.693C806.777 322.923 659.667 53.3832 659.667 53.3832C745.991 49.9861 824.403 67.2582 865.683 103.753C914.021 146.488 898.341 203.998 834.783 251.394L699.973 292.504L565.164 333.615Z" fill="url(#paint1_onboarding)" fillOpacity="0.5" />
      </g>
      <g filter="url(#filter1_onboarding)">
        <path d="M553.458 206.295C591.351 179.436 638.583 283.38 605.528 237.037C586.609 210.515 405.501 159.413 329.924 47.8193C278.531 21.1859 347.638 84.6732 311.03 67.5571C225.432 27.5361 236.71 33.7096 146.233 22.2948C55.7553 10.88 -19.8787 17.6545 -64.8557 41.2019C-109.833 64.7493 -120.67 103.246 -95.103 148.644C-69.5354 194.042 -9.54218 242.826 72.3332 284.795C154.209 326.765 251.627 358.671 344.22 373.843C436.813 389.015 517.412 386.277 569.165 366.203L259.916 200.202L553.458 206.295Z" fill="url(#paint2_onboarding)" fillOpacity="0.5" />
      </g>
      <g style={{ mixBlendMode: "screen" }} filter="url(#filter2_onboarding)">
        <path d="M504.659 120.119C456.036 -43.0669 -97.7422 235.24 335.476 -48.6804C382.591 -123.276 512.993 -184.562 685.856 -150.017C858.719 -115.471 960.658 -26.9948 913.543 47.6013C841.588 3.21703 677.522 154.665 504.659 120.119Z" fill="url(#paint3_onboarding)" />
      </g>
      <g style={{ mixBlendMode: "color-dodge" }} opacity="0.4" filter="url(#filter3_onboarding)">
        <path d="M638.18 20.285C638.18 2.46861 595.126 -14.6581 518.02 -27.5142C440.914 -40.3704 335.725 -47.9605 224.448 -48.6977C113.171 -49.4349 4.4194 -43.2621 -79.0676 -31.4699C-162.554 -19.6777 -214.313 -3.1791 -223.522 14.5763C-232.731 32.3318 -198.677 49.9693 -128.48 63.8013C-58.2829 77.6333 42.6219 86.5888 153.137 88.7954C263.653 91.0019 375.222 86.2887 464.518 75.6412C553.814 64.9937 613.924 49.2362 632.278 31.6634L206.59 20.285H638.18Z" fill="url(#paint4_onboarding)" fillOpacity="0.5" />
      </g>
      <defs>
        <filter id="filter0_onboarding" x="300" y="16" width="631" height="354" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="18" result="effect1" />
        </filter>
        <filter id="filter1_onboarding" x="-145" y="-20" width="798" height="440" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="18" result="effect1" />
        </filter>
        <filter id="filter2_onboarding" x="114" y="-217" width="867" height="398" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="28" result="effect1" />
        </filter>
        <filter id="filter3_onboarding" x="-262" y="-86" width="936" height="211" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="18" result="effect1" />
        </filter>
        <linearGradient id="paint0_onboarding" x1="865.683" y1="103.754" x2="556.915" y2="453.003" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="paint1_onboarding" cx="0" cy="0" r="1" gradientTransform="matrix(-270.391 96.77 -131.98 -116.683 615.184 193.404)" gradientUnits="userSpaceOnUse">
          <stop offset="0.062" stopColor="#1F9CF0" />
          <stop offset="1" stopColor="#1F9CF0" stopOpacity="0.17" />
        </radialGradient>
        <radialGradient id="paint2_onboarding" cx="0" cy="0" r="1" gradientTransform="matrix(-146.844 104.085 -332.591 -148.465 259.917 200.202)" gradientUnits="userSpaceOnUse">
          <stop offset="0.1875" stopColor="#065F46" />
          <stop offset="0.943" stopColor="#2FE2AF" stopOpacity="0.29" />
        </radialGradient>
        <linearGradient id="paint3_onboarding" x1="913.543" y1="47.6012" x2="409.579" y2="-270.703" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="paint4_onboarding" x1="206.59" y1="-48.7568" x2="206.59" y2="89.3269" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1F9CF0" />
          <stop offset="1" stopColor="#84BDFF" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function OnboardingProgress({
  className,
  onDepositClick,
}: OnboardingProgressProps) {
  const router = useRouter();
  const params = useParams();
  const treasuryId = params?.treasuryId as string | undefined;
  const { selectedTreasury: accountId } = useTreasury();
  const { isGuestTreasury, isLoading: isLoadingGuestTreasury } = useIsGuestTreasury();
  const { data, isLoading: isLoadingAssets } = useAssets(accountId);
  const { tokens } = data || { tokens: [] };
  const { data: proposals, isLoading: isLoadingProposals } = useProposals(accountId, {
    types: ["Payments"],
  });

  const isLoading = isLoadingAssets || isLoadingProposals || isLoadingGuestTreasury;


  const tokenBalanceIsPositive = (token: TreasuryAsset) => {
    const tokenBalance = Big(availableBalance(token.balance)).div(Big(10).pow(token.decimals));
    if (token.symbol === "NEAR") {
      return tokenBalance.gt(1);
    }
    return true;
  }
  const hasAssets = tokens.filter(tokenBalanceIsPositive).length > 0;

  const steps: OnboardingStep[] = useMemo(() => {
    let activeStep = 1;

    const step2Completed = hasAssets;
    const step3Completed = !!proposals?.proposals?.length && proposals.proposals.length > 0;

    if (!step3Completed) activeStep = 3;
    if (!hasAssets) activeStep = 2;


    return [
      {
        id: "create-treasury",
        title: "Create Treasury account",
        description: "You've successfully set up your account. Great start!",
        completed: true,
        active: false,
      },
      {
        id: "add-assets",
        title: "Add Your Assets",
        description: "Begin by adding assets to see them in action.",
        completed: step2Completed,
        active: activeStep === 2,
        action: {
          label: "Deposit",
          icon: "deposit" as const,
          onClick: () => onDepositClick?.() || (() => { }),
        },
      },
      {
        id: "create-payment",
        title: "Create a Payment Request",
        description: "Create a payment request to complete your setup.",
        completed: step3Completed,
        active: activeStep === 3,
        action: {
          label: "Send",
          icon: "send" as const,
          onClick: () => router.push(treasuryId ? `/${treasuryId}/payments` : "/payments"),
        },
      },
    ];
  }, [hasAssets, proposals, treasuryId, router, onDepositClick]);

  const completedSteps = steps.filter((s) => s.completed).length;

  // Don't show onboarding if all steps are completed
  const showOnboarding = completedSteps < steps.length && !isLoading && !isGuestTreasury;

  if (!showOnboarding) {
    return null;
  }

  return (
    <div
      className={cn(
        "relative flex md:flex-row flex-col gap-6 items-center overflow-hidden px-5 py-4 rounded-xl bg-[#076f56]",
        className
      )}
    >
      {/* Background gradient overlay from Figma */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <GradientOverlay />
      </div>

      {/* Left section - Progress indicator */}
      <div className="relative z-10 flex flex-col gap-4 items-center justify-center shrink-0 w-[209px] ">
        <SemiCircleProgress current={completedSteps} total={steps.length} />
        <p className="text-base font-semibold text-white text-center leading-snug">
          Follow Quick Steps to
          <br />
          Explore the Treasury
        </p>
      </div>

      {/* Right section - Step cards */}
      <div className="relative z-10 flex flex-col gap-2 flex-1 min-w-0">
        {steps.map((step, index) => (
          <StepCard key={step.id} step={step} index={index} />
        ))}
      </div>
    </div>
  );
}

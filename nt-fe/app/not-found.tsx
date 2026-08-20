import { Icon } from "@/components/icon";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import Link from "next/link";

export default function NotFound() {
    const t = useTranslations("notFound");
    return (
        <div className="dark relative flex min-h-screen flex-col items-center justify-center bg-black overflow-x-hidden">
            {/* Spotlight beam — trapezoid path matches Figma SVG exactly */}
            <svg
                className="absolute top-0 left-1/2 h-[60vh] w-2/3 -translate-x-1/2 pointer-events-none select-none"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 641 649"
                fill="none"
            >
                <g filter="url(#filter0_f_2670_45910)">
                    <path
                        d="M286.209 -120H350.705L510.2 518H130.2L286.209 -120Z"
                        fill="url(#paint0_linear_2670_45910)"
                        fillOpacity="0.5"
                    />
                </g>
                <defs>
                    <filter
                        id="filter0_f_2670_45910"
                        x="1.52588e-05"
                        y="-250.2"
                        width="640.4"
                        height="898.4"
                        filterUnits="userSpaceOnUse"
                        colorInterpolationFilters="sRGB"
                    >
                        <feFlood floodOpacity="0" result="BackgroundImageFix" />
                        <feBlend
                            mode="normal"
                            in="SourceGraphic"
                            in2="BackgroundImageFix"
                            result="shape"
                        />
                        <feGaussianBlur
                            stdDeviation="65.1"
                            result="effect1_foregroundBlur_2670_45910"
                        />
                    </filter>
                    <linearGradient
                        id="paint0_linear_2670_45910"
                        x1="313.036"
                        y1="-120"
                        x2="313.036"
                        y2="538.086"
                        gradientUnits="userSpaceOnUse"
                    >
                        <stop stopColor="white" stopOpacity="0.64" />
                        <stop
                            offset="0.3125"
                            stopColor="white"
                            stopOpacity="0.31"
                        />
                        <stop
                            offset="0.698617"
                            stopColor="white"
                            stopOpacity="0.16"
                        />
                        <stop offset="1" stopColor="white" stopOpacity="0" />
                    </linearGradient>
                </defs>
            </svg>

            {/* Large 404 background text */}
            <p
                className="relative -mt-[8vh] font-medium text-neutral-600 whitespace-nowrap pointer-events-none select-none leading-[1.2] tracking-tight"
                style={{ fontSize: "clamp(120px, 23vw, 330px)" }}
            >
                404
            </p>

            {/* Content card — negative top margin creates overlap with 404 text */}
            <div
                className={cn(
                    "relative -mt-[8vw] w-[437px] max-w-[calc(100%-2rem)] overflow-clip rounded-xl p-6",
                    "bg-linear-to-b from-[rgba(39,39,39,0.07)] to-[rgba(40,40,40,0.14)]",
                    "backdrop-blur-[14px]",
                    "flex flex-col items-center gap-6",
                )}
            >
                <div className="flex flex-col items-center gap-1.5 text-center w-full">
                    <h1 className="text-2xl font-medium text-foreground tracking-[-0.48px] leading-snug">
                        {t("title")}
                    </h1>
                    <p className="text-base text-muted-foreground leading-6">
                        {t("description")}
                    </p>
                </div>
                <Link href="/">
                    <Button>
                        {t("backToDashboard")}
                        <Icon icon={ArrowRight01Icon} />
                    </Button>
                </Link>
            </div>
        </div>
    );
}

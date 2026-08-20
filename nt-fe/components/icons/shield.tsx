import { Icon } from "@/components/icon";
import { GlobeIcon, Shield01Icon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
export type TreasuryType = "confidential" | "public";

const treasuryTypeIconVariants = cva(
    "flex items-center justify-center bg-general-tertiary rounded-full",
    {
        variants: {
            size: {
                default: "size-7",
                sm: "size-4",
            },
        },
        defaultVariants: {
            size: "default",
        },
    },
);

type IconSize = VariantProps<typeof treasuryTypeIconVariants>["size"];

function ConfidentialIconWithPattern({ size }: { size?: IconSize }) {
    const dim = size === "sm" ? 16 : 28;
    return (
        <svg
            width={dim}
            height={dim}
            viewBox="0 0 28 28"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <g clipPath="url(#clip0_6269_20654)">
                <rect width="28" height="28" rx="14" fill="#171717" />
                <rect
                    x="14.7779"
                    y="-1.55469"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.27"
                />
                <rect
                    x="25.8519"
                    y="-1.55469"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="14.7779"
                    y="3.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.29"
                />
                <rect
                    x="14.7779"
                    y="9.03809"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.3"
                />
                <rect
                    x="25.8519"
                    y="3.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="25.8519"
                    y="9.03809"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="20.0742"
                    y="-1.55469"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="20.0742"
                    y="3.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.35"
                />
                <rect
                    x="20.0742"
                    y="9.03809"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.22"
                />
                <rect
                    x="14.7779"
                    y="14.1492"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.28"
                />
                <rect
                    x="25.8519"
                    y="14.1492"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.46"
                />
                <rect
                    x="14.7779"
                    y="19.4453"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.46"
                />
                <rect
                    x="25.8519"
                    y="19.4453"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="14.7779"
                    y="24.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="25.8519"
                    y="24.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="20.0742"
                    y="14.1492"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="20.0742"
                    y="19.4453"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="20.0742"
                    y="24.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.46"
                />
                <rect
                    x="-1.55554"
                    y="-1.55469"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.46"
                />
                <rect
                    x="9.51862"
                    y="-1.55469"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.21"
                />
                <rect
                    x="-1.55542"
                    y="3.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="-1.55542"
                    y="9.03809"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.02"
                />
                <rect
                    x="9.51862"
                    y="3.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="9.51862"
                    y="9.03809"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="3.74091"
                    y="-1.55469"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="3.74091"
                    y="3.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.31"
                />
                <rect
                    x="3.74091"
                    y="9.03809"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.27"
                />
                <rect
                    x="-1.55542"
                    y="14.1492"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="9.51862"
                    y="14.1492"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.21"
                />
                <rect
                    x="-1.55542"
                    y="19.4453"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.46"
                />
                <rect
                    x="9.51862"
                    y="19.4453"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="-1.55542"
                    y="24.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="9.51862"
                    y="24.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.58"
                />
                <rect
                    x="3.74091"
                    y="14.1492"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="3.74091"
                    y="19.4453"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                />
                <rect
                    x="3.74091"
                    y="24.7417"
                    width="4.33333"
                    height="4.33333"
                    rx="1.08333"
                    fill="#262626"
                    fillOpacity="0.46"
                />
                <path
                    d="M18.1482 14.5186C18.1482 17.1112 16.3333 18.4075 14.1763 19.1594C14.0634 19.1977 13.9407 19.1958 13.8289 19.1542C11.6667 18.4075 9.85187 17.1112 9.85187 14.5186V10.889C9.85187 10.7515 9.9065 10.6196 10.0037 10.5224C10.101 10.4251 10.2329 10.3705 10.3704 10.3705C11.4074 10.3705 12.7037 9.74826 13.6059 8.96012C13.7158 8.86626 13.8555 8.8147 14 8.8147C14.1445 8.8147 14.2842 8.86626 14.3941 8.96012C15.3015 9.75345 16.5926 10.3705 17.6296 10.3705C17.7672 10.3705 17.8991 10.4251 17.9963 10.5224C18.0935 10.6196 18.1482 10.7515 18.1482 10.889V14.5186Z"
                    stroke="#F5F5F5"
                    strokeWidth="0.907407"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </g>
            <defs>
                <clipPath id="clip0_6269_20654">
                    <rect width="28" height="28" rx="14" fill="white" />
                </clipPath>
            </defs>
        </svg>
    );
}

export function TreasuryTypeIcon({
    type,
    size,
    className,
}: {
    type: "confidential" | "public";
    size?: IconSize;
    className?: string;
}) {
    if (type === "confidential") {
        return <ConfidentialIconWithPattern size={size} />;
    }
    const globeSize = size === "sm" ? "size-2" : "size-3";
    return (
        <div className={cn(treasuryTypeIconVariants({ size }), className)}>
            <Icon
                icon={GlobeIcon}
                className={cn("text-foreground", globeSize)}
            />
        </div>
    );
}

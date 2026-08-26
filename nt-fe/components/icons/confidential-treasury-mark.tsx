import { cn } from "@/lib/utils";

/** Confidential treasury mark for transfer / pay "Goes to" summary. */
export function ConfidentialTreasuryMark({
    className,
}: {
    className?: string;
}) {
    return (
        <svg
            width="36"
            height="36"
            viewBox="0 0 36 36"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={cn("size-9 shrink-0", className)}
            aria-hidden
        >
            <path
                d="M0 18C0 8.05888 8.05888 0 18 0C27.9411 0 36 8.05888 36 18C36 27.9411 27.9411 36 18 36C8.05888 36 0 27.9411 0 18Z"
                fill="#171717"
            />
            <path
                d="M22.4725 12.3289C21.211 11.7012 19.6673 11.332 18 11.332C16.3327 11.332 14.789 11.7012 13.5274 12.3289C12.9088 12.6367 12.5995 12.7906 12.2997 13.2746C12 13.7585 12 14.227 12 15.1641V17.4901C12 21.279 15.0282 23.3856 16.782 24.2879C17.2711 24.5396 17.5157 24.6654 18 24.6654C18.4843 24.6654 18.7289 24.5396 19.2179 24.2879C20.9717 23.3856 24 21.279 24 17.4901V15.1641C24 14.227 24 13.7585 23.7003 13.2746C23.4005 12.7906 23.0912 12.6367 22.4725 12.3289Z"
                stroke="#00EC97"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

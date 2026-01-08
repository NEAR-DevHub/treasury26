export function NumberBadge({ number }: { number: number }) {
    return (
        <span className="flex size-5 items-center justify-center rounded-[8px] px-2 py-[3px] bg-orange-500 text-xs font-semibold text-white">
            {number}
        </span>
    );
}

/** Width and padding per column, from the design. Shared by header and body. */
export const COLUMN_CLASS: Record<string, string> = {
    select: "w-10 px-3",
    id: "px-3",
    transaction: "px-4",
    proposer: "px-3",
    voting: "w-[200px] px-3",
    status: "w-[132px] px-3",
    expand: "w-[60px] px-3",
};

/** The order the requests table lays its columns out in. */
export const COLUMN_IDS = [
    "select",
    "id",
    "transaction",
    "proposer",
    "voting",
    "status",
    "expand",
] as const;

export const HEAD_CLASS =
    "h-10 text-sm font-semibold normal-case leading-[1.5] text-general-secondary-foreground";

import type { ReactNode } from "react";

const SPUTNIK_DAO_SUFFIX = ".sputnik-dao.near";
const HIGHLIGHT_LEN = 5;

export function isSputnikDaoAddress(address: string): boolean {
    return address.toLowerCase().endsWith(SPUTNIK_DAO_SUFFIX);
}

/** Bold first/last 5 chars for non–sputnik-dao addresses; sputnik dao ids stay plain. */
export function formatDepositAddress(
    address: string,
    preferPlain = false,
): ReactNode {
    if (
        preferPlain ||
        isSputnikDaoAddress(address) ||
        address.length <= HIGHLIGHT_LEN * 2
    ) {
        return <span className="text-foreground">{address}</span>;
    }

    const first = address.slice(0, HIGHLIGHT_LEN);
    const middle = address.slice(HIGHLIGHT_LEN, -HIGHLIGHT_LEN);
    const last = address.slice(-HIGHLIGHT_LEN);

    return (
        <>
            <span className="text-foreground font-semibold">{first}</span>
            <span className="text-muted-foreground">{middle}</span>
            <span className="text-foreground font-semibold">{last}</span>
        </>
    );
}

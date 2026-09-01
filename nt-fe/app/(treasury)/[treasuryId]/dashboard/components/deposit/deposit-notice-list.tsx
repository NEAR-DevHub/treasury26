"use client";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
    DepositNoticeIcon,
    type DepositNoticeTone,
} from "./deposit-notice-icon";

export interface DepositNoticeItem {
    id: string;
    tone: DepositNoticeTone;
    content: ReactNode;
}

interface DepositNoticeListProps {
    notices: DepositNoticeItem[];
    className?: string;
    footer?: ReactNode;
}

export function DepositNoticeList({
    notices,
    className,
    footer,
}: DepositNoticeListProps) {
    return (
        <div className={cn("space-y-2.5", className)}>
            {notices.map((notice) => (
                <div
                    key={notice.id}
                    className="flex gap-2 items-start text-sm font-medium leading-normal text-muted-foreground"
                >
                    <DepositNoticeIcon tone={notice.tone} />
                    <span>{notice.content}</span>
                </div>
            ))}
            {footer}
        </div>
    );
}

export function DepositNoticeInfoRow({ children }: { children: ReactNode }) {
    return (
        <div className="flex gap-2 items-start text-sm font-medium leading-normal text-muted-foreground">
            <DepositNoticeIcon tone="info" />
            <span>{children}</span>
        </div>
    );
}

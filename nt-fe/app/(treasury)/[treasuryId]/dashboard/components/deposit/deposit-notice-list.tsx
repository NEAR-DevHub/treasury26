"use client";

import { Info } from "lucide-react";
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
                    className="flex gap-2 items-start text-sm text-muted-foreground"
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
        <div className="flex gap-2 items-start text-sm text-muted-foreground">
            <Info className="size-4 shrink-0 mt-0.5" />
            <span>{children}</span>
        </div>
    );
}

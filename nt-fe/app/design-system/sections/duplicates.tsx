"use client";

import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/alert";
import { PageCard } from "@/components/card";
import { GuestBadge } from "@/components/guest-badge";
import { InfoAlert } from "@/components/info-alert";
import { NetworkBadge } from "@/components/network-badge";
import { NumberBadge } from "@/components/number-badge";
import { Pill } from "@/components/pill";
import { RoleBadge } from "@/components/role-badge";
import {
    Alert as UiAlert,
    AlertDescription as UiAlertDescription,
} from "@/components/ui/alert";
import {
    Card as UiCard,
    CardContent as UiCardContent,
} from "@/components/ui/card";
import { WarningAlert } from "@/components/warning-alert";

import { duplicateGroups, rawColorHotspots } from "../data";

function GroupHeader({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
        </div>
    );
}

function MemberList({
    members,
}: {
    members: { name: string; filePath: string; usageCount: number }[];
}) {
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground">
            {members.map((m) => (
                <span key={m.filePath}>
                    {m.name} — {m.filePath} ({m.usageCount})
                </span>
            ))}
        </div>
    );
}

export function Duplicates() {
    const badges = duplicateGroups.find((g) => g.id === "badges");
    const cards = duplicateGroups.find((g) => g.id === "cards");
    const alerts = duplicateGroups.find((g) => g.id === "alerts");
    if (!badges || !cards || !alerts) return null;

    return (
        <section id="duplicates" className="scroll-mt-20 flex flex-col gap-10">
            <div>
                <h2 className="text-2xl font-bold">
                    Duplicates &amp; consolidation opportunities
                </h2>
                <p className="text-sm text-muted-foreground">
                    Same visual job, independent implementations, no shared base
                    primitive. Rendered side by side so the drift is visible,
                    not just described.
                </p>
            </div>

            {/* Badges */}
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                <GroupHeader
                    title={badges.title}
                    description={badges.description}
                />
                <div className="flex flex-wrap items-center gap-3">
                    <Pill title="Pill" variant="default" />
                    <Pill
                        title="Pill / info"
                        variant="info"
                        info="Info tooltip"
                    />
                    <NetworkBadge name="near" />
                    <NumberBadge number={3} />
                    <NumberBadge number={2} variant="error" />
                    {/* biome-ignore lint/a11y/useValidAriaRole: RoleBadge's "role" prop is a member-role string, not an ARIA role */}
                    <RoleBadge role="Approver" showTooltip={false} />
                    <GuestBadge />
                </div>
                <MemberList members={badges.members} />
            </div>

            {/* Cards */}
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                <GroupHeader
                    title={cards.title}
                    description={cards.description}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                            components/ui/card.tsx
                        </span>
                        <UiCard>
                            <UiCardContent>
                                Border, no shadow, rounded-xl.
                            </UiCardContent>
                        </UiCard>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                            components/card.tsx (PageCard)
                        </span>
                        <PageCard>
                            Border, rounded-[14px], different padding.
                        </PageCard>
                    </div>
                </div>
                <MemberList members={cards.members} />
            </div>

            {/* Alerts */}
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                <GroupHeader
                    title={alerts.title}
                    description={alerts.description}
                />
                <div className="flex flex-col gap-2">
                    <UiAlert>
                        <AlertTriangle className="size-4" />
                        <UiAlertDescription>
                            ui/alert.tsx — raw shadcn Alert (default variant)
                        </UiAlertDescription>
                    </UiAlert>
                    <Alert variant="warning">
                        <AlertTriangle className="size-4" />
                        <AlertDescription>
                            components/alert.tsx — wrapper adding the
                            &quot;warning&quot; variant on top of ui/alert
                        </AlertDescription>
                    </Alert>
                    <InfoAlert message="components/info-alert.tsx — imports @/components/alert (the wrapper)" />
                    <WarningAlert message="components/warning-alert.tsx — imports @/components/alert (the wrapper)" />
                </div>
                <MemberList members={alerts.members} />
            </div>

            {/* Raw colors */}
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
                <GroupHeader
                    title="Raw / hardcoded colors outside globals.css"
                    description="Values that bypass the token system entirely — can't be retheme'd centrally."
                />
                <ul className="flex flex-col gap-1.5 text-sm">
                    {rawColorHotspots.map((hotspot) => (
                        <li key={hotspot.filePath} className="flex gap-2">
                            <code className="text-xs font-mono text-muted-foreground shrink-0">
                                {hotspot.filePath}
                            </code>
                            <span className="text-muted-foreground">
                                {hotspot.detail}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
}

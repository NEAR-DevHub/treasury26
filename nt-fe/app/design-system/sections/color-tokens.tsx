"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { tokenInfo } from "../data";

const GROUPS: { title: string; tokens: string[] }[] = [
    {
        title: "Core",
        tokens: [
            "background",
            "foreground",
            "card",
            "card-foreground",
            "popover",
            "popover-foreground",
            "primary",
            "primary-foreground",
            "secondary",
            "secondary-foreground",
            "muted",
            "muted-foreground",
            "accent",
            "accent-foreground",
            "destructive",
            "destructive-foreground",
            "border",
            "input",
            "ring",
        ],
    },
    {
        title: "Status / general",
        tokens: [
            "general-border",
            "general-unofficial-border",
            "general-unofficial-ghost-foreground",
            "general-unofficial-accent",
            "general-unofficial-accent-0",
            "general-success-background-faded",
            "general-success-foreground",
            "general-orange-background",
            "general-orange-background-faded",
            "general-orange-foreground",
            "general-destructive-background-faded",
            "general-destructive-foreground",
            "general-info-background-faded",
            "general-info-border",
            "general-info-foreground",
            "general-warning-background-faded",
            "general-warning-foreground",
            "general-tertiary",
            "general-secondary",
        ],
    },
    { title: "Brand", tokens: ["brand-green"] },
    { title: "Chart", tokens: ["chart-area-fill"] },
];

export function ColorTokens() {
    const { resolvedTheme } = useTheme();
    const [values, setValues] = useState<Record<string, string>>({});
    const [mounted, setMounted] = useState(false);

    // resolvedTheme isn't read directly below, but its change is what should
    // trigger a re-read of the CSS vars after next-themes swaps the class.
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run trigger
    useEffect(() => {
        setMounted(true);
        const style = getComputedStyle(document.documentElement);
        const next: Record<string, string> = {};
        for (const group of GROUPS) {
            for (const token of group.tokens) {
                next[token] = style.getPropertyValue(`--${token}`).trim();
            }
        }
        setValues(next);
    }, [resolvedTheme]);

    return (
        <section id="colors" className="scroll-mt-20 flex flex-col gap-6">
            <div>
                <h2 className="text-2xl font-bold">Color tokens</h2>
                <p className="text-sm text-muted-foreground">
                    Live values read from{" "}
                    <code className="font-mono">app/globals.css</code> via{" "}
                    <code className="font-mono">getComputedStyle</code> — always
                    in sync with the source of truth. Currently showing:{" "}
                    <strong>{mounted ? resolvedTheme : "…"}</strong> theme. Use
                    the toggle in the header to switch. Purpose and usage counts
                    below come from{" "}
                    <code className="font-mono">
                        grep -rl -- &quot;&lt;token&gt;&quot;
                        --include=&quot;*.tsx&quot;
                    </code>{" "}
                    across app/components/features/hooks/lib (excluding this
                    page) — real call sites, not guesses.
                </p>
                {mounted && (
                    <p className="text-sm text-muted-foreground mt-2">
                        --brand-green ({values["brand-green"]}) — renamed from
                        --brand-blue during cleanup; the value was always NEAR
                        green, the old name just said otherwise.
                        (--onboarding-primary used to share this exact value —
                        removed as a dead token, 0 usages anywhere in app code.)
                    </p>
                )}
            </div>
            {GROUPS.map((group) => (
                <div key={group.title} className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        {group.title}
                    </h3>
                    <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card overflow-hidden">
                        {group.tokens.map((token) => {
                            const info = tokenInfo[token];
                            const dead = info?.usageCount === 0;
                            return (
                                <div
                                    key={token}
                                    className="flex items-start gap-3 px-3 py-2.5"
                                >
                                    <div
                                        className="size-10 shrink-0 rounded-md border border-border mt-0.5"
                                        style={{
                                            background: `var(--${token})`,
                                        }}
                                    />
                                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                            <code className="text-xs font-mono font-semibold">
                                                --{token}
                                            </code>
                                            <span className="text-[10px] text-muted-foreground font-mono">
                                                {values[token] || "…"}
                                            </span>
                                            {info && (
                                                <span
                                                    className={`text-[10px] font-medium rounded-full px-1.5 py-px ${
                                                        dead
                                                            ? "bg-general-destructive-background-faded text-general-destructive-foreground"
                                                            : "bg-muted text-muted-foreground"
                                                    }`}
                                                >
                                                    {dead
                                                        ? "unused"
                                                        : `${info.usageCount} ${info.usageCount === 1 ? "file" : "files"}`}
                                                </span>
                                            )}
                                        </div>
                                        {info ? (
                                            <>
                                                <p className="text-xs text-foreground/80">
                                                    {info.purpose}
                                                </p>
                                                {info.example && (
                                                    <code className="text-[10px] font-mono text-muted-foreground truncate">
                                                        e.g. {info.example}
                                                    </code>
                                                )}
                                            </>
                                        ) : (
                                            <p className="text-xs text-muted-foreground italic">
                                                No description yet.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </section>
    );
}

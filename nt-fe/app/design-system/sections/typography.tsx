const SIZES = [
    { cls: "text-xxs", label: "text-xxs (0.625rem) — custom token" },
    { cls: "text-xs", label: "text-xs" },
    { cls: "text-sm", label: "text-sm" },
    { cls: "text-base", label: "text-base" },
    { cls: "text-lg", label: "text-lg" },
    { cls: "text-xl", label: "text-xl" },
    { cls: "text-2xl", label: "text-2xl" },
    { cls: "text-3xl", label: "text-3xl" },
];

const WEIGHTS = [
    { cls: "font-normal", label: "font-normal (400)" },
    { cls: "font-medium", label: "font-medium (500)" },
    { cls: "font-semibold", label: "font-semibold (600)" },
    { cls: "font-bold", label: "font-bold (700)" },
];

export function Typography() {
    return (
        <section id="typography" className="scroll-mt-20 flex flex-col gap-6">
            <div>
                <h2 className="text-2xl font-bold">Typography</h2>
                <p className="text-sm text-muted-foreground">
                    Font: Figtree (--font-sans), loaded via next/font/google in
                    every layout independently — no shared layout wraps the
                    whole app (there is no app/layout.tsx). Mono: Geist Mono.
                    Serif: static system stack, no serif webfont loaded. No
                    tailwind.config.* exists — the only typography addition
                    beyond Tailwind defaults is{" "}
                    <code className="font-mono">--text-xxs</code> in the{" "}
                    <code className="font-mono">@theme inline</code> block.{" "}
                    <code className="font-mono">@tailwindcss/typography</code>{" "}
                    is imported but no <code className="font-mono">prose</code>{" "}
                    className usage was found anywhere in the codebase.
                </p>
            </div>

            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    Scale (font-sans / Figtree)
                </h3>
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {SIZES.map((s) => (
                        <div
                            key={s.cls}
                            className="flex items-baseline gap-4 px-4 py-3"
                        >
                            <span className="w-56 shrink-0 text-xs font-mono text-muted-foreground">
                                {s.label}
                            </span>
                            <span className={s.cls}>
                                The quick brown fox jumps over the lazy dog
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    Weights
                </h3>
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {WEIGHTS.map((w) => (
                        <div
                            key={w.cls}
                            className="flex items-baseline gap-4 px-4 py-3"
                        >
                            <span className="w-56 shrink-0 text-xs font-mono text-muted-foreground">
                                {w.label}
                            </span>
                            <span className={`text-lg ${w.cls}`}>
                                The quick brown fox jumps over the lazy dog
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    font-mono (Geist Mono)
                </h3>
                <div className="rounded-lg border border-border bg-card px-4 py-3">
                    <span className="font-mono text-sm">
                        const total = formatCurrency(1234.56);
                    </span>
                </div>
            </div>
        </section>
    );
}

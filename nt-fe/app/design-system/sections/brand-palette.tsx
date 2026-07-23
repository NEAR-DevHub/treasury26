const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const COLORS = ["green", "red", "yellow"] as const;
const GRAY_SHADES = [25, 150, 850] as const;

export function BrandPalette() {
    return (
        <section id="palette" className="scroll-mt-20 flex flex-col gap-6">
            <div>
                <h2 className="text-2xl font-bold">Raw brand palette</h2>
                <p className="text-sm text-muted-foreground">
                    Defined in the <code className="font-mono">@theme</code>{" "}
                    block of <code className="font-mono">app/globals.css</code>{" "}
                    (oklch). Brand green is{" "}
                    <code className="font-mono">green-500</code> (
                    <code className="font-mono">#00EC97</code>). These are the
                    raw scale — most UI should use the semantic tokens above
                    instead of reaching for these directly.
                </p>
            </div>
            {COLORS.map((color) => (
                <div key={color} className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        {color}
                    </h3>
                    <div className="grid grid-cols-6 sm:grid-cols-11 gap-2">
                        {SHADES.map((shade) => (
                            <div
                                key={shade}
                                className="flex flex-col gap-1 rounded-lg overflow-hidden border border-border"
                            >
                                <div
                                    className="h-12"
                                    style={{
                                        background: `var(--color-${color}-${shade})`,
                                    }}
                                />
                                <div className="px-1.5 pb-1.5 text-[10px] font-mono text-foreground/70 bg-card">
                                    {shade}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    extra gray stops
                </h3>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 max-w-md">
                    {GRAY_SHADES.map((shade) => (
                        <div
                            key={shade}
                            className="flex flex-col gap-1 rounded-lg overflow-hidden border border-border"
                        >
                            <div
                                className="h-12"
                                style={{
                                    background: `var(--color-gray-${shade})`,
                                }}
                            />
                            <div className="px-1.5 pb-1.5 text-[10px] font-mono text-foreground/70 bg-card">
                                {shade}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

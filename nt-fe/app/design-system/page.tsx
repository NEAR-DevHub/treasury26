import { BrandPalette } from "./sections/brand-palette";
import { ColorTokens } from "./sections/color-tokens";
import { ComponentInventory } from "./sections/component-inventory";
import { Duplicates } from "./sections/duplicates";
import { ThemeToggle } from "./sections/theme-toggle";
import { Typography } from "./sections/typography";

const NAV = [
    { href: "#colors", label: "Colors" },
    { href: "#palette", label: "Brand palette" },
    { href: "#typography", label: "Typography" },
    { href: "#components", label: "Components" },
    { href: "#duplicates", label: "Duplicates" },
];

export default function DesignSystemPage() {
    return (
        <div className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur px-4 md:px-6">
                <div className="flex items-center justify-between h-14 gap-4 max-w-6xl mx-auto">
                    <div className="flex items-center gap-2 shrink-0">
                        <span className="font-bold text-sm md:text-base">
                            Design System
                        </span>
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                            Trezu / nt-fe
                        </span>
                    </div>
                    <nav className="flex items-center gap-1 overflow-x-auto">
                        {NAV.map((item) => (
                            <a
                                key={item.href}
                                href={item.href}
                                className="text-xs md:text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted whitespace-nowrap"
                            >
                                {item.label}
                            </a>
                        ))}
                    </nav>
                    <ThemeToggle />
                </div>
            </header>

            <main className="max-w-6xl mx-auto px-4 md:px-6 py-10 flex flex-col gap-16">
                <ColorTokens />
                <BrandPalette />
                <Typography />
                <ComponentInventory />
                <Duplicates />
            </main>
        </div>
    );
}

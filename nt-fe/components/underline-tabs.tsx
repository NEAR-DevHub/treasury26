import { Tabs, TabsContent, TabsContents, TabsList as AnimateTabsList } from "@/components/animate-ui/components/animate/tabs";
import { TabsTrigger as BaseTabsTrigger } from "@/components/animate-ui/primitives/animate/tabs";
import { cn } from "@/lib/utils";

function TabsList({ className, ...props }: React.ComponentProps<typeof AnimateTabsList>) {
    return (
        <AnimateTabsList {...props} className={cn("bg-transparent w-full p-0 h-auto border-b rounded-none border-border relative justify-start", className)} />
    );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof BaseTabsTrigger>) {
    return (
        <BaseTabsTrigger
            {...props}
            className={cn("data-[state=active]:text-foreground hover:text-foreground/80 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-muted-foreground inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs md:text-sm font-medium whitespace-nowrap transition-colors duration-200 ease-in-out focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 border-none! bg-transparent! shadow-none! pb-2 relative data-[state=active]:after:content-[''] data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-0 data-[state=active]:after:right-0 data-[state=active]:after:h-[2px] data-[state=active]:after:bg-primary", className)}
        />
    );
}


export {
    Tabs,
    TabsContent,
    TabsContents,
    TabsList,
    TabsTrigger,
}

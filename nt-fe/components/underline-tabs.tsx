import { Tabs, TabsContent, TabsContents, TabsList as AnimateTabsList } from "@/components/animate-ui/components/animate/tabs";
import { TabsTrigger as BaseTabsTrigger } from "@/components/animate-ui/primitives/animate/tabs";

function TabsList({ ...props }: React.ComponentProps<typeof AnimateTabsList>) {
    return (
        <AnimateTabsList {...props} className="bg-transparent w-full p-0 h-auto border-b rounded-none border-border relative justify-start" />
    );
}

function TabsTrigger({ ...props }: React.ComponentProps<typeof BaseTabsTrigger>) {
    return (
        <BaseTabsTrigger
            {...props}
            className="data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-muted-foreground inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-500 ease-in-out focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 border-none! bg-transparent! shadow-none! pb-2 relative data-[state=active]:after:content-[''] data-[state=active]:after:absolute data-[state=active]:after:bottom-0 data-[state=active]:after:left-0 data-[state=active]:after:right-0 data-[state=active]:after:h-[2px] data-[state=active]:after:bg-primary"
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

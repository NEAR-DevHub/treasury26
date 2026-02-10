import { SearchX } from "lucide-react";

interface RequestErrorStateProps {
    title?: string;
    message?: string;
}

export function RequestErrorState({
    title = "Oops! Something went wrong",
    message = "We couldn't find any data to show here.",
}: RequestErrorStateProps) {
    return (
        <div className="flex items-center justify-center w-full min-h-[250px] py-12 px-4">
            <div className="flex flex-col items-center gap-4 w-full max-w-md text-center">
                <div className="size-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <SearchX className="size-5 text-muted-foreground" />
                </div>
                <div className="flex flex-col gap-2">
                    <div className="text-lg font-semibold text-foreground">
                        {title}
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {message}
                    </p>
                </div>
            </div>
        </div>
    );
}



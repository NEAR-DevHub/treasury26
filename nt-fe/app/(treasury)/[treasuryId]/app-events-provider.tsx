"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
    APP_EVENT_NAMES,
    type AppEventScope,
    handleAppEvent,
    parseAppEvent,
} from "@/lib/app-events";

function buildAppEventsUrl(scope: AppEventScope) {
    const backendBaseUrl = process.env.NEXT_PUBLIC_BACKEND_API_BASE;
    if (!backendBaseUrl || !scope.treasuryId) {
        return null;
    }

    const url = new URL("/api/app-events", backendBaseUrl);
    url.searchParams.set("accountId", scope.treasuryId);
    return url.toString();
}

export function AppEventsProvider({ scope }: { scope: AppEventScope }) {
    const queryClient = useQueryClient();
    const treasuryId = scope.treasuryId;

    useEffect(() => {
        const activeScope: AppEventScope = { treasuryId };
        const url = buildAppEventsUrl(activeScope);
        if (!url) {
            return;
        }

        const eventSource = new EventSource(url, {
            withCredentials: true,
        });

        const handleMessage = (message: MessageEvent<string>) => {
            const event = parseAppEvent(message.data);
            if (!event) {
                return;
            }

            void handleAppEvent(queryClient, event, activeScope);
        };

        for (const eventName of APP_EVENT_NAMES) {
            eventSource.addEventListener(eventName, handleMessage);
        }

        return () => {
            for (const eventName of APP_EVENT_NAMES) {
                eventSource.removeEventListener(eventName, handleMessage);
            }
            eventSource.close();
        };
    }, [queryClient, treasuryId]);

    return null;
}

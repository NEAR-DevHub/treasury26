"use client";

import { useEffect, useState } from "react";
import { hasInAppHistory } from "@/lib/in-app-navigation";

/** False on the server and first paint; then true if the user arrived in-app. */
export function useInAppHistory(): boolean {
    const [cameFromApp, setCameFromApp] = useState(false);
    useEffect(() => {
        setCameFromApp(hasInAppHistory());
    }, []);
    return cameFromApp;
}

"use client";

import { useEffect } from "react";
import { useNearStore } from "@/stores/near-store";

export function NearInitializer() {
    useEffect(() => {
        useNearStore.getState().init();
    }, []);

    return null;
}

"use client";

import { useState, useEffect } from "react";
import { parseFilterData } from "../types/filter-types";

interface UseFilterStateOptions<T> {
    value: string;
    onUpdate: (value: string) => void;
    parseData: (parsed: any) => T;
    serializeData: (operation: string, data: T) => object;
    defaultOperation?: string;
}

export function useFilterState<T>({
    value,
    onUpdate,
    parseData,
    serializeData,
    defaultOperation = "Is"
}: UseFilterStateOptions<T>) {
    const [operation, setOperation] = useState<string>(defaultOperation);
    const [data, setData] = useState<T | null>(null);

    // Parse on mount - NO FALLBACK for old format
    useEffect(() => {
        if (value) {
            const parsed = parseFilterData(value);
            if (parsed) {
                setOperation(parsed.operation || defaultOperation);
                setData(parseData(parsed));
            }
        } else {
            // Clear state when value is empty
            setData(null);
            setOperation(defaultOperation);
        }
    }, [value, defaultOperation, parseData]);

    // Update when state changes
    useEffect(() => {
        if (data) {
            const filterValue = JSON.stringify(serializeData(operation, data));
            onUpdate(filterValue);
        }
    }, [operation, data, onUpdate, serializeData]);

    const handleClear = () => {
        setData(null);
        onUpdate("");
    };

    return { operation, setOperation, data, setData, handleClear };
}

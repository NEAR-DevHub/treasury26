"use client";

import { useState, useEffect, useRef } from "react";
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
    const isInitialMount = useRef(true);

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
        isInitialMount.current = false;
    }, [value]);

    // Update when state changes (but skip initial mount to avoid loop)
    useEffect(() => {
        if (!isInitialMount.current && data) {
            const filterValue = JSON.stringify(serializeData(operation, data));
            if (filterValue !== value) {
                onUpdate(filterValue);
            }
        }
    }, [operation, data]);

    const handleClear = () => {
        setData(null);
        onUpdate("");
    };

    return { operation, setOperation, data, setData, handleClear };
}

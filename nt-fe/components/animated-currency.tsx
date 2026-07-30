"use client";

import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect } from "react";
import { formatCurrencyWithSubCent } from "@/lib/utils";

/**
 * Currency figure that counts up to its new value instead of snapping.
 */
export function AnimatedCurrency({
    value,
    className,
}: {
    value: number;
    className?: string;
}) {
    const count = useMotionValue(0);
    const formatted = useTransform(count, (latest) =>
        formatCurrencyWithSubCent(latest),
    );

    useEffect(() => {
        const controls = animate(count, value, {
            duration: 0.5,
            ease: "easeOut",
        });
        return () => controls.stop();
    }, [count, value]);

    return <motion.span className={className}>{formatted}</motion.span>;
}

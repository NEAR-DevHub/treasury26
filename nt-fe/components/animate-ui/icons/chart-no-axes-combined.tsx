"use client";

import { motion, type Variants } from "motion/react";
import {
    getVariants,
    useAnimateIconContext,
    IconWrapper,
    type IconProps,
} from "@/components/animate-ui/icons/icon";

type ChartNoAxesCombinedProps = IconProps<keyof typeof animations>;

const animations = {
    default: {
        bar1: {},
        bar2: {},
        bar3: {},
        bar4: {},
        bar5: {},
        trend: {
            initial: { pathLength: 1, opacity: 1 },
            animate: {
                pathLength: [0, 1],
                opacity: 1,
                transition: { duration: 0.45, ease: "easeInOut" as const },
            },
        },
    } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: ChartNoAxesCombinedProps) {
    const { controls } = useAnimateIconContext();
    const variants = getVariants(animations);

    return (
        <motion.svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...props}
        >
            <motion.path
                d="M4 18.463V21"
                variants={variants.bar1}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="M8 14.656V21"
                variants={variants.bar2}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="M12 16V21"
                variants={variants.bar3}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="M16 14.639V21"
                variants={variants.bar4}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="M20 10.656V21"
                variants={variants.bar5}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15"
                variants={variants.trend}
                initial="initial"
                animate={controls}
            />
        </motion.svg>
    );
}

function ChartNoAxesCombined(props: ChartNoAxesCombinedProps) {
    return <IconWrapper icon={IconComponent} {...props} />;
}

export { ChartNoAxesCombined, type ChartNoAxesCombinedProps };

"use client";

import { motion, type Variants } from "motion/react";

import {
    getVariants,
    type IconProps,
    IconWrapper,
    useAnimateIconContext,
} from "@/components/animate-ui/icons/icon";

type CodeXmlProps = IconProps<keyof typeof animations>;

// Each keyframe list starts AND ends at the resting (visible) value, so the icon is fully drawn at
// rest and the hover just plays a flourish — no jump-to-hidden first frame (cf. bookmark's outline).
const animations = {
    default: {
        // "<" dips in toward centre and springs back out to rest.
        left: {
            initial: { x: 0 },
            animate: {
                x: [0, 4, 0],
                transition: { duration: 0.35, ease: "easeInOut" },
            },
        },
        // ">" mirrors it.
        right: {
            initial: { x: 0 },
            animate: {
                x: [0, -4, 0],
                transition: { duration: 0.35, ease: "easeInOut" },
            },
        },
        // "/" erases and redraws itself top → bottom, just after the brackets move.
        slash: {
            initial: { pathLength: 1 },
            animate: {
                pathLength: [1, 0, 1],
                transition: { duration: 0.4, ease: "easeInOut", delay: 0.1 },
            },
        },
    } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: CodeXmlProps) {
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
                d="m18 16 4-4-4-4"
                variants={variants.right}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="m6 8-4 4 4 4"
                variants={variants.left}
                initial="initial"
                animate={controls}
            />
            <motion.path
                d="m14.5 4-5 16"
                variants={variants.slash}
                initial="initial"
                animate={controls}
            />
        </motion.svg>
    );
}

function CodeXml(props: CodeXmlProps) {
    return <IconWrapper icon={IconComponent} {...props} />;
}

export {
    animations,
    CodeXml,
    CodeXml as CodeXmlIcon,
    type CodeXmlProps,
    type CodeXmlProps as CodeXmlIconProps,
};

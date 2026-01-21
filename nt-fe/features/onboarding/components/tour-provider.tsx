"use client";

import { TourProvider as ReactourTourProvider } from '@reactour/tour'
import { TOURS } from '../steps'

export function TourProvider({ children }: { children: React.ReactNode }) {
    return (
        <ReactourTourProvider steps={TOURS} disableDotsNavigation>
            {children}
        </ReactourTourProvider>
    )
}

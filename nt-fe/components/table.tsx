"use client"

import * as React from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader as TableHeaderUI, TableRow, TableFooter, TableCaption } from "@/components/ui/table"

import { cn } from "@/lib/utils"

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
    return (
        <TableHeaderUI
            className={cn("border-b border-t bg-general-tertiary", className)}
            {...props}
        />
    )
}

export {
    Table,
    TableHeader,
    TableBody,
    TableFooter,
    TableHead,
    TableRow,
    TableCell,
    TableCaption,
}

"use client";

import { Loader2, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { Input } from "@/components/input";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/underline-tabs";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "";
const AUTH_COOKIE_NAME = "auth_token";
const JWT_PLACEHOLDER = "YOUR_JWT";
const DEFAULT_ACCOUNT_ID = "treasury.sputnik-dao.near";

type TransactionType =
    | "all"
    | "incoming"
    | "outgoing"
    | "staking_rewards"
    | "exchange";

const TRANSACTION_TYPES: { value: TransactionType; labelKey: string }[] = [
    { value: "all", labelKey: "all" },
    { value: "outgoing", labelKey: "sent" },
    { value: "incoming", labelKey: "received" },
    { value: "staking_rewards", labelKey: "stakingRewards" },
    { value: "exchange", labelKey: "exchange" },
];

const QUERY_PARAMS = [
    "accountId",
    "limit",
    "offset",
    "minUsdValue",
    "transactionType",
    "tokenSymbol",
    "tokenSymbolNot",
    "txHash",
    "from",
    "fromNot",
    "to",
    "toNot",
    "startDate",
    "endDate",
] as const;

type QueryParam = (typeof QUERY_PARAMS)[number];

const PARAM_INPUTS: Record<
    QueryParam,
    {
        type: "text" | "number" | "date" | "select";
        placeholder?: string;
        min?: number;
        max?: number;
    }
> = {
    accountId: { type: "text" },
    limit: { type: "number", min: 1, max: 100, placeholder: "10" },
    offset: { type: "number", min: 0, placeholder: "0" },
    minUsdValue: { type: "number", min: 0, placeholder: "100" },
    transactionType: { type: "select" },
    tokenSymbol: { type: "text", placeholder: "USDC" },
    tokenSymbolNot: { type: "text", placeholder: "NEAR" },
    txHash: { type: "text" },
    from: { type: "text", placeholder: "alice.near,bob.near" },
    fromNot: { type: "text", placeholder: "alice.near" },
    to: { type: "text", placeholder: "alice.near,bob.near" },
    toNot: { type: "text", placeholder: "alice.near" },
    startDate: { type: "date" },
    endDate: { type: "date" },
};

// Params the backend parses as numbers — rendered unquoted in Python.
const NUMERIC_PARAMS = new Set<QueryParam>(["limit", "offset", "minUsdValue"]);

function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
    return (
        <div className="relative">
            <pre className="bg-muted rounded-lg p-4 pr-14 text-sm overflow-x-auto whitespace-pre">
                <code>{code}</code>
            </pre>
            <CopyButton
                text={code}
                variant="ghost"
                size="icon"
                aria-label={copyLabel}
                className="absolute top-2 right-2"
            />
        </div>
    );
}

export default function ApiDocsPage() {
    const t = useTranslations("pages.apiDocs");
    const tDocs = useTranslations("apiDocs");
    const tTabs = useTranslations("activity.tabs");
    const { treasuryId } = useTreasury();
    const { accountId } = useNear();

    const [paramValues, setParamValues] = useState<
        Partial<Record<QueryParam, string>>
    >({});
    const [isRunning, setIsRunning] = useState(false);
    const [response, setResponse] = useState<string | null>(null);
    const [responseMeta, setResponseMeta] = useState<{
        status: number;
        ok: boolean;
        duration: number;
    } | null>(null);

    const defaults = useMemo<Partial<Record<QueryParam, string>>>(
        () => ({
            accountId: treasuryId ?? DEFAULT_ACCOUNT_ID,
            limit: "10",
            offset: "0",
            transactionType: "all",
        }),
        [treasuryId],
    );

    const getValue = (param: QueryParam) =>
        paramValues[param] ?? defaults[param] ?? "";

    const setValue = (param: QueryParam, value: string) =>
        setParamValues((prev) => ({ ...prev, [param]: value }));

    // Params that end up in the request: non-empty, and "all" means
    // no transactionType filter.
    const activeEntries = useMemo(
        () =>
            QUERY_PARAMS.map(
                (param) =>
                    [
                        param,
                        (paramValues[param] ?? defaults[param] ?? "").trim(),
                    ] as [QueryParam, string],
            ).filter(
                ([param, value]) =>
                    value !== "" &&
                    !(param === "transactionType" && value === "all"),
            ),
        [paramValues, defaults],
    );

    const queryParams = useMemo(
        () => new URLSearchParams(activeEntries),
        [activeEntries],
    );

    const requestUrl = `${BACKEND_API_BASE}/api/recent-activity?${queryParams.toString()}`;

    const curlSnippet = useMemo(
        () =>
            [
                `curl "${requestUrl}" \\`,
                `  --cookie "${AUTH_COOKIE_NAME}=${JWT_PLACEHOLDER}"`,
            ].join("\n"),
        [requestUrl],
    );

    const pythonSnippet = useMemo(() => {
        const paramLines = activeEntries.map(([param, value]) => {
            const isNumeric =
                NUMERIC_PARAMS.has(param) && !Number.isNaN(Number(value));
            const rendered = isNumeric
                ? value
                : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
            return `        "${param}": ${rendered},`;
        });
        return [
            "import requests",
            "",
            `BASE_URL = "${BACKEND_API_BASE}"`,
            `JWT = "${JWT_PLACEHOLDER}"  # DevTools -> Application -> Cookies -> ${AUTH_COOKIE_NAME}`,
            "",
            "response = requests.get(",
            '    f"{BASE_URL}/api/recent-activity",',
            "    params={",
            ...paramLines,
            "    },",
            `    cookies={"${AUTH_COOKIE_NAME}": JWT},`,
            ")",
            "response.raise_for_status()",
            "activity = response.json()",
            "print(f\"Total: {activity['total']}\")",
            'for item in activity["data"]:',
            '    symbol = item["tokenMetadata"]["symbol"]',
            '    print(item["blockTime"], item["amount"], symbol, item["counterparty"])',
        ].join("\n");
    }, [activeEntries]);

    const handleRun = async () => {
        setIsRunning(true);
        setResponse(null);
        setResponseMeta(null);
        const startedAt = performance.now();
        try {
            const res = await fetch(requestUrl, { credentials: "include" });
            const text = await res.text();
            setResponseMeta({
                status: res.status,
                ok: res.ok,
                duration: Math.round(performance.now() - startedAt),
            });
            try {
                setResponse(JSON.stringify(JSON.parse(text), null, 2));
            } catch {
                setResponse(text);
            }
        } catch (error) {
            setResponse(
                `${tDocs("requestFailed")}: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            setIsRunning(false);
        }
    };

    return (
        <PageComponentLayout
            title={t("title")}
            description={t("description")}
            backButton={`/${treasuryId}/dashboard`}
        >
            <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
                {/* Endpoint */}
                <PageCard className="gap-3">
                    <p className="font-semibold">{tDocs("endpoint")}</p>
                    <p className="text-sm text-muted-foreground">
                        {tDocs("endpointDescription")}
                    </p>
                    <CodeBlock
                        code={`GET ${BACKEND_API_BASE}/api/recent-activity`}
                        copyLabel={tDocs("copy")}
                    />
                </PageCard>

                {/* Authentication */}
                <PageCard className="gap-3">
                    <p className="font-semibold">{tDocs("authentication")}</p>
                    <p className="text-sm text-muted-foreground">
                        {tDocs("authIntro", { cookie: AUTH_COOKIE_NAME })}
                    </p>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                        <li>{tDocs("authStep1")}</li>
                        <li>
                            {tDocs("authStep2", { cookie: AUTH_COOKIE_NAME })}
                        </li>
                        <li>
                            {tDocs("authStep3", {
                                placeholder: JWT_PLACEHOLDER,
                            })}
                        </li>
                    </ul>
                    <p className="text-sm text-muted-foreground">
                        {tDocs("authPublicNote")}
                    </p>
                </PageCard>

                {/* Query parameters: edit values to build the request below */}
                <PageCard className="gap-3">
                    <p className="font-semibold">{tDocs("parameters")}</p>
                    <p className="text-sm text-muted-foreground">
                        {tDocs("parametersDescription")}
                    </p>
                    <Table>
                        <TableHeader>
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="text-xs font-medium uppercase text-muted-foreground w-44">
                                    {tDocs("paramName")}
                                </TableHead>
                                <TableHead className="text-xs font-medium uppercase text-muted-foreground">
                                    {tDocs("paramDescription")}
                                </TableHead>
                                <TableHead className="text-xs font-medium uppercase text-muted-foreground w-56">
                                    {tDocs("paramValue")}
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {QUERY_PARAMS.map((param) => {
                                const input = PARAM_INPUTS[param];
                                return (
                                    <TableRow key={param}>
                                        <TableCell className="align-top pt-4">
                                            <code className="text-sm">
                                                {param}
                                            </code>
                                            {param === "accountId" && (
                                                <span className="ml-2 text-xs text-muted-foreground border border-general-border rounded px-1.5 py-0.5">
                                                    {tDocs("required")}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-sm whitespace-normal align-top pt-4">
                                            {tDocs(`params.${param}`)}
                                        </TableCell>
                                        <TableCell className="align-top">
                                            {input.type === "select" ? (
                                                <Select
                                                    value={getValue(param)}
                                                    onValueChange={(value) =>
                                                        setValue(param, value)
                                                    }
                                                >
                                                    <SelectTrigger
                                                        aria-label={param}
                                                        className="w-full"
                                                    >
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {TRANSACTION_TYPES.map(
                                                            (type) => (
                                                                <SelectItem
                                                                    key={
                                                                        type.value
                                                                    }
                                                                    value={
                                                                        type.value
                                                                    }
                                                                >
                                                                    {tTabs(
                                                                        type.labelKey,
                                                                    )}
                                                                </SelectItem>
                                                            ),
                                                        )}
                                                    </SelectContent>
                                                </Select>
                                            ) : (
                                                <Input
                                                    aria-label={param}
                                                    type={input.type}
                                                    min={input.min}
                                                    max={input.max}
                                                    placeholder={
                                                        input.placeholder
                                                    }
                                                    value={getValue(param)}
                                                    onChange={(e) =>
                                                        setValue(
                                                            param,
                                                            e.target.value,
                                                        )
                                                    }
                                                />
                                            )}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </PageCard>

                {/* Code examples built from the parameter values above */}
                <PageCard className="gap-4">
                    <p className="font-semibold">{tDocs("examples")}</p>
                    <p className="text-sm text-muted-foreground">
                        {tDocs("examplesDescription")}
                    </p>

                    <Tabs defaultValue="curl">
                        <TabsList>
                            <TabsTrigger value="curl">cURL</TabsTrigger>
                            <TabsTrigger value="python">Python</TabsTrigger>
                        </TabsList>
                        <TabsContent value="curl" className="mt-4">
                            <CodeBlock
                                code={curlSnippet}
                                copyLabel={tDocs("copy")}
                            />
                        </TabsContent>
                        <TabsContent value="python" className="mt-4">
                            <CodeBlock
                                code={pythonSnippet}
                                copyLabel={tDocs("copy")}
                            />
                        </TabsContent>
                    </Tabs>

                    <div className="flex flex-wrap items-center gap-3">
                        <Button onClick={handleRun} disabled={isRunning}>
                            {isRunning ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Play className="w-4 h-4" />
                            )}
                            {isRunning ? tDocs("running") : tDocs("run")}
                        </Button>
                        <p className="text-sm text-muted-foreground">
                            {accountId
                                ? tDocs("signedInAs", { accountId })
                                : tDocs("notSignedIn")}
                        </p>
                    </div>

                    {response !== null && (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-3">
                                <p className="text-sm font-medium">
                                    {tDocs("response")}
                                </p>
                                {responseMeta && (
                                    <span
                                        className={cn(
                                            "text-xs font-medium rounded px-1.5 py-0.5",
                                            responseMeta.ok
                                                ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                                                : "bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400",
                                        )}
                                    >
                                        {tDocs("responseMeta", {
                                            status: responseMeta.status,
                                            duration: responseMeta.duration,
                                        })}
                                    </span>
                                )}
                            </div>
                            <div className="relative">
                                <pre className="bg-muted rounded-lg p-4 pr-14 text-sm overflow-auto max-h-96 whitespace-pre">
                                    <code>{response}</code>
                                </pre>
                                <CopyButton
                                    text={response}
                                    variant="ghost"
                                    size="icon"
                                    aria-label={tDocs("copy")}
                                    className="absolute top-2 right-2"
                                />
                            </div>
                        </div>
                    )}
                </PageCard>
            </div>
        </PageComponentLayout>
    );
}

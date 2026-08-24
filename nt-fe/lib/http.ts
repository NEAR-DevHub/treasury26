import * as Sentry from "@sentry/nextjs";
import axios, { type AxiosError } from "axios";

/**
 * Shared axios instance for backend/API calls.
 *
 * Reports unexpected failures (5xx, network errors, timeouts) to Sentry
 * once, centrally, tagged `error_code=FE_API_FAILED` and fingerprinted by
 * method + path. Expected client outcomes (4xx: auth, validation,
 * not-found, rate limit) are not reported.
 *
 * Import as `import { http as axios } from "@/lib/http"` to keep call sites
 * unchanged.
 */
export const http = axios.create();

const REPORTED = Symbol.for("trezu.sentryReported");

/** True when this error was already sent to Sentry (by the interceptor). */
export function isReportedError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as Record<symbol, unknown>)[REPORTED] === true
    );
}

export function markReportedError(error: unknown): void {
    if (typeof error === "object" && error !== null) {
        (error as Record<symbol, unknown>)[REPORTED] = true;
    }
}

function requestPath(error: AxiosError): string {
    const url = error.config?.url ?? "unknown";
    try {
        return new URL(url, "http://relative").pathname;
    } catch {
        return url;
    }
}

function reportHttpError(error: AxiosError): void {
    const status = error.response?.status;
    // 4xx are expected client outcomes (auth rejection, validation,
    // not-found, rate limit) — Info by the error taxonomy, never reported.
    if (status !== undefined && status < 500) {
        return;
    }

    const method = (error.config?.method ?? "get").toUpperCase();
    const path = requestPath(error);

    Sentry.withScope((scope) => {
        scope.setTag("error_code", "FE_API_FAILED");
        scope.setTag("priority", "p2");
        scope.setTag("endpoint", `${method} ${path}`);
        scope.setTag(
            "http_status",
            status !== undefined ? String(status) : "network",
        );
        scope.setFingerprint(["FE_API_FAILED", method, path]);
        scope.setContext("request", {
            status,
            code: error.code,
        });
        Sentry.captureException(error);
    });
    markReportedError(error);
}

http.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
        if (axios.isAxiosError(error)) {
            reportHttpError(error);
        }
        return Promise.reject(error);
    },
);

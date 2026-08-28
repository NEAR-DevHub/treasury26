import type { Event } from "@sentry/nextjs";

/**
 * Last-line redaction for outgoing Sentry events, mirroring the backend's
 * sensitive-key list (nt-be/src/observability.rs). One unsanitized capture
 * must never leak a token, JWT, or cookie to Sentry.
 */

const SENSITIVE_KEY_RE =
    /^(access[_-]?token|refresh[_-]?token|token|jwt|secret|api[_-]?key|authorization|cookie|set[_-]?cookie)$/i;
const JWT_RE =
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const SENSITIVE_KV_RE =
    /\b(accessToken|access_token|refreshToken|refresh_token|token|jwt|secret|apiKey|api_key|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi;

const REDACTED = "[REDACTED]";

function scrubString(input: string): string {
    return input
        .replace(
            SENSITIVE_KV_RE,
            (_match, key, sep) => `${key}${sep}${REDACTED}`,
        )
        .replace(JWT_RE, REDACTED);
}

function scrubValue(value: unknown, depth = 0): unknown {
    if (depth > 8) {
        return value;
    }
    if (typeof value === "string") {
        return scrubString(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => scrubValue(item, depth + 1));
    }
    if (typeof value === "object" && value !== null) {
        const scrubbed: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            scrubbed[key] = SENSITIVE_KEY_RE.test(key)
                ? REDACTED
                : scrubValue(child, depth + 1);
        }
        return scrubbed;
    }
    return value;
}

export function scrubSentryEvent<E extends Event>(event: E): E {
    if (event.message) {
        event.message = scrubString(event.message);
    }
    for (const exception of event.exception?.values ?? []) {
        if (exception.value) {
            exception.value = scrubString(exception.value);
        }
    }
    for (const breadcrumb of event.breadcrumbs ?? []) {
        if (breadcrumb.message) {
            breadcrumb.message = scrubString(breadcrumb.message);
        }
        if (breadcrumb.data) {
            breadcrumb.data = scrubValue(breadcrumb.data) as Record<
                string,
                unknown
            >;
        }
    }
    if (event.extra) {
        event.extra = scrubValue(event.extra) as Record<string, unknown>;
    }
    if (event.request?.headers) {
        event.request.headers = scrubValue(event.request.headers) as Record<
            string,
            string
        >;
    }
    if (event.request?.cookies) {
        event.request.cookies = { [REDACTED]: REDACTED };
    }
    return event;
}

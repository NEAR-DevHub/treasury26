import { z } from "zod";

/** Telegram usernames: @prefix, 5-32 chars, alphanumeric + underscore, must start with a letter. */
const TELEGRAM_USERNAME_REGEX = /^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

function looksLikeEmail(value: string): boolean {
    const atIndex = value.indexOf("@");
    return atIndex > 0;
}

export function isValidWaitlistContact(contact: string): boolean {
    const trimmed = contact.trim();
    if (!trimmed) {
        return false;
    }

    if (looksLikeEmail(trimmed)) {
        return z.email().safeParse(trimmed).success;
    }

    return TELEGRAM_USERNAME_REGEX.test(trimmed);
}

export const APP_DOCS_URL = "https://docs.trezu.org/";
export const APP_DEMO_URL = "https://youtu.be/KIQeS2Y0AWY";
export const APP_ACTIVE_TREASURY = "/trezu-demo.sputnik-dao.near";
export const APP_ACTIVE_CONFIDENTIAL_TREASURY =
    "/trezu-confidential.sputnik-dao.near";
export const APP_TWITTER_URL = "https://x.com/TrezuApp";
export const APP_CONTACT_US_URL = "https://trezu.org/contact-us";
export const LOCKUP_NO_WHITELIST_ACCOUNT_ID = "lockup-no-whitelist.near";
export const LANDING_PAGE = "https://business.near.com";
export const TERMS_OF_SERVICE_URL = "https://trezu.org/terms-of-use";
export const PRIVACY_POLICY_URL = "https://trezu.org/privacy-policy";

export const APP_WALLET_SETUP_URL = undefined;

/** Telegram bot handle without @ (used for t.me links). */
export const TELEGRAM_BOT_HANDLE = process.env.NEXT_PUBLIC_TELEGRAM_BOT_HANDLE;

/** Telegram bot @username shown in integration instructions (add bot to group chat). */
export const TELEGRAM_BOT_USERNAME = `@${TELEGRAM_BOT_HANDLE}`;

/** Open the bot in Telegram (deep link). */
export const TELEGRAM_BOT_URL = `https://t.me/${TELEGRAM_BOT_HANDLE}`;

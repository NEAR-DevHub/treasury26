/**
 * Feature flags for hiding features in production.
 *
 * Each flag reads from a NEXT_PUBLIC_FEATURE_* env variable.
 * When the variable is not set or is not "true", the feature is disabled.
 *
 * To enable a feature in staging, set the corresponding env variable:
 *   NEXT_PUBLIC_STAGING=true
 */

export const isStaging =
    process.env.NEXT_PUBLIC_STAGING === "true" ||
    process.env.NODE_ENV === "development";

export const features = isStaging
    ? {
          integrations: true,
          extraLocales: true,
      }
    : {
          integrations: false,
          // In production only en/es/uk are exposed in the language switcher.
          extraLocales: false,
      };

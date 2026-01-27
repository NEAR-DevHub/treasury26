/**
 * ISO 3166-1 alpha-2 country codes for sanctioned/restricted jurisdictions.
 *
 * Sources:
 * - OFAC (U.S. Office of Foreign Assets Control) — comprehensive sanctions programs
 *   https://ofac.treasury.gov/sanctions-programs-and-country-information
 * - EU restrictive measures
 *
 * geoip-lite uses these same ISO codes.
 */
export const SANCTIONED_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea (DPRK)
  "SY", // Syria
  "VE", // Venezuela
  "RU", // Russia
  "BY", // Belarus
]);

/**
 * Sanctioned sub-national regions keyed by country code.
 *
 * geoip-lite region codes for Ukraine:
 * - "43" = Crimea (Autonomous Republic of Crimea)
 * - "14" = Donetsk Oblast
 * - "09" = Luhansk Oblast
 *
 * IPs assigned from Russian blocks to these territories will resolve as "RU"
 * and be caught by SANCTIONED_COUNTRY_CODES. This map catches IPs that
 * resolve as "UA" but are in sanctioned regions.
 */
export const SANCTIONED_REGIONS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  [
    "UA",
    new Set([
      "43", // Crimea
      "14", // Donetsk
      "09", // Luhansk
    ]),
  ],
]);

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
  "AF", // Afghanistan
  "BY", // Belarus
  "CF", // Central African Republic
  "CD", // Democratic Republic of Congo
  "CU", // Cuba
  "GW", // Guinea-Bissau
  "HT", // Haiti
  "IR", // Iran
  "KP", // North Korea (DPRK)
  "LY", // Libya
  "ML", // Mali
  "MM", // Myanmar (Burma)
  "NI", // Nicaragua
  "RU", // Russia
  "SD", // Sudan
  "SO", // Somalia
  "SS", // South Sudan
  "SY", // Syria
  "VE", // Venezuela
  "YE", // Yemen
  "ZW", // Zimbabwe
]);

/**
 * Sanctioned sub-national regions keyed by country code.
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
      "40", // Sevastopol
      "14", // Donetsk
      "09", // Luhansk
      "23", // Zaporizhzhia
      "65", // Kherson
    ]),
  ],
]);

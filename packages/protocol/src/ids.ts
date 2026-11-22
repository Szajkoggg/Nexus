/**
 * Identifiers (ULIDs, queue and step ids, paths used as keys) compared by UTF-16 code unit, never by locale.
 *
 * `localeCompare` follows the process's or the browser's language: in hu-HU, CS, GY, LY, NY, TY, ZS (and DZ, DZS) are
 * letters of their own, so "…ZS" sorts after "…ZT", and two monotonic ULIDs written in the same millisecond can come
 * out reversed (a step.done before its step.started). The ESLint config forbids `localeCompare` on id-like names.
 */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

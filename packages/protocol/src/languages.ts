// The languages Nexus offers (PROTOCOL.md, "Languages"): for the reader's language (what agents write to the user in)
// and a project's working language (what its agents work in). The order is the user's list.

/** Each offered language: its code (ISO 639-1, as stored), its name in English, and its own name. */
export const LANGUAGES = [
  { code: "hu", name: "Hungarian", native: "magyar" },
  { code: "en", name: "English", native: "English" },
  { code: "da", name: "Danish", native: "dansk" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "es", name: "Spanish", native: "español" },
  { code: "fr", name: "French", native: "français" },
  { code: "pl", name: "Polish", native: "polski" },
  { code: "it", name: "Italian", native: "italiano" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];

/** The working language a project has when it names none. */
export const DEFAULT_WORKING_LANGUAGE: LanguageCode = "en";

/** A language's English name, by its code. */
export const languageName = (code: LanguageCode): string => LANGUAGES.find((l) => l.code === code)!.name;

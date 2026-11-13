// The dashboard's theme, chosen per browser (not per project) and kept in localStorage. The themes are sets of the
// colour tokens in index.css: Graphite (the default), Paper (light) and Honey (warm dark); "system" follows the
// system's light or dark, Paper when light and Graphite when dark.
//
// The pure part (parsing the stored choice, resolving it) has no DOM in it and is unit tested. The same rules run once
// more in a small inline script in index.html, before the stylesheet paints, so a page never shows the wrong theme
// first; keep the two in step.

export const THEMES = ["graphite", "paper", "honey"] as const;
export type Theme = (typeof THEMES)[number];
export type ThemeChoice = Theme | "system";

export const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Follow the system (Paper when light, Graphite when dark)" },
  { value: "graphite", label: "Graphite (dark)" },
  { value: "paper", label: "Paper (light)" },
  { value: "honey", label: "Honey (warm dark)" },
];

/** The localStorage key; index.html's inline script reads it too. */
export const THEME_KEY = "nexus.theme";
/** Without a stored choice: Graphite, the proposals' default. */
export const DEFAULT_CHOICE: ThemeChoice = "graphite";

/** The stored choice; anything missing or unknown is the default. */
export function parseChoice(raw: string | null | undefined): ThemeChoice {
  return raw === "system" || (THEMES as readonly string[]).includes(raw ?? "") ? (raw as ThemeChoice) : DEFAULT_CHOICE;
}

/** The theme a choice shows, given whether the system is dark now. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === "system" ? (systemDark ? "graphite" : "paper") : choice;
}

/** The browser bar's colour per theme: the theme's page colour (`--color-canvas`). */
export const THEME_COLOR: Record<Theme, string> = { graphite: "#0e0f12", paper: "#f4f3ef", honey: "#13110e" };

// ---------------------------------------------------------------- the browser

const DARK = "(prefers-color-scheme: dark)";
const systemDark = () => typeof matchMedia !== "undefined" && matchMedia(DARK).matches;

export function readChoice(): ThemeChoice {
  try { return parseChoice(localStorage.getItem(THEME_KEY)); } catch { return DEFAULT_CHOICE; }
}

/** Shows a theme: `data-theme` on <html> (index.css keys the tokens on it) and the browser bar's colour. */
export function applyTheme(choice: ThemeChoice = readChoice()): Theme {
  const theme = resolveTheme(choice, systemDark());
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  return theme;
}

/** Stores the choice for this browser and shows it. */
export function setChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(THEME_KEY, choice); } catch { /* private mode: the choice lasts until the page closes */ }
  applyTheme(choice);
}

/** Follows the system's light and dark while the page is open (for "system"), and a choice made in another tab. */
export function watchTheme(): void {
  if (typeof matchMedia !== "undefined") matchMedia(DARK).addEventListener("change", () => applyTheme());
  window.addEventListener("storage", (e) => { if (e.key === THEME_KEY) applyTheme(); });
}

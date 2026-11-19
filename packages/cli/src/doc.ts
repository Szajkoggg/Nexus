// `nexus doc`: reading a Markdown file by its headings, so an agent takes one section instead of the whole file.
// Only ATX headings count (`#` to `######`, at most three spaces before them); a `#` line inside a fenced code block
// (``` or ~~~) is not one.

export interface DocHeading {
  level: number;
  text: string;
  /** 1-based line number of the heading. */
  line: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The file's headings in order, the ones inside fenced code blocks left out. */
export function docHeadings(lines: readonly string[]): DocHeading[] {
  const out: DocHeading[] = [];
  let fence: string | undefined;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const f = FENCE.exec(line);
    if (fence) {
      // A fence closes with the same character, at least as long, and nothing after it.
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = undefined;
      return;
    }
    if (f) { fence = f[1]; return; }
    const h = ATX.exec(line);
    if (h) out.push({ level: h[1]!.length, text: (h[2] ?? "").trim(), line: i + 1 });
  });
  return out;
}

/** The headings as `nexus doc <file>` prints them: indented by level, with their marks and line numbers. */
export const headingsText = (hs: readonly DocHeading[]): string =>
  hs.map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}  (line ${h.line})`).join("\n");

/** A GitHub-style anchor of a heading: lower case, punctuation dropped, spaces as hyphens. */
const slug = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");

/**
 * The headings a section name picks: a date (2026-11-14) picks every heading that begins with it (`### 2026-11-14` and
 * `### 2026-11-14 (later): …`, one dated entry); otherwise the heading whose text, or anchor, is the name (case
 * ignored), else the one heading that begins with the name as whole words (`Static analysis` for `Static analysis
 * (queue SA)`). Several headings beginning with it are an error naming them.
 */
export function pickHeadings(hs: readonly DocHeading[], name: string): DocHeading[] {
  const want = name.trim();
  if (DATE.test(want)) return hs.filter((h) => h.text === want || h.text.startsWith(`${want} `) || h.text.startsWith(`${want}:`));
  const lower = want.toLowerCase();
  const exact = hs.filter((h) => h.text.toLowerCase() === lower || slug(h.text) === slug(want));
  if (exact.length) return exact;
  const begins = hs.filter((h) => h.text.toLowerCase().startsWith(lower) && /^\W/.test(h.text.slice(want.length)));
  if (begins.length > 1) throw new Error(`"${name}" begins several headings: ${begins.map((h) => `${h.text} (line ${h.line})`).join("; ")}; give one in full`);
  return begins;
}

/** A section's lines: from its heading to the next heading of the same or a higher level (or the file's end). */
export function sectionText(lines: readonly string[], hs: readonly DocHeading[], h: DocHeading): string {
  const next = hs.find((x) => x.line > h.line && x.level <= h.level);
  const end = next ? next.line - 1 : lines.length;
  return lines.slice(h.line - 1, end).map((l) => l.replace(/\r$/, "")).join("\n").replace(/\s+$/, "");
}

/** What a name that picks no heading is told: the sections there are, and the dates. */
export function sectionOptions(hs: readonly DocHeading[]): string {
  const dates = [...new Set(hs.map((h) => /^(\d{4}-\d{2}-\d{2})\b/.exec(h.text)?.[1]).filter((d): d is string => !!d))];
  const names = [...new Set(hs.map((h) => h.text).filter(Boolean))];
  return [`its sections: ${names.join("; ") || "(none)"}`, ...(dates.length ? [`its dates: ${dates.join(", ")}`] : [])].join("; ");
}

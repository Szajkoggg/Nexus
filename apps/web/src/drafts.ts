// Unsent text in the dashboard's text boxes. Kept in the browser only (localStorage), never sent to the server, so it
// survives closing a panel, switching project, a reload, and a phone discarding the tab.
//
// The pure part (keys, reading, writing, pruning a map) has no DOM in it and is unit tested; the localStorage part
// below it is a thin wrapper.

/** One stored draft: the text and when it was last touched (ms since the epoch). */
export interface Draft { text: string; at: number }
export type Drafts = Record<string, Draft>;

/** Drafts untouched for this long are dropped when the page loads. */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The key of a draft: the project and the target in it (a chat, a conversation, a step, a question…). */
export function draftKey(project: string, ...target: string[]): string {
  return [project, ...target].map(encodeURIComponent).join("/");
}

/** Parses the stored map; anything malformed is skipped rather than thrown. */
export function parseDrafts(raw: string | null): Drafts {
  if (!raw) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Drafts = {};
  for (const [k, v] of Object.entries(data)) {
    const d = v as Partial<Draft> | null;
    if (d && typeof d.text === "string" && typeof d.at === "number" && d.text !== "") out[k] = { text: d.text, at: d.at };
  }
  return out;
}

/** The map with the draft set; empty text removes it. Never changes its argument. */
export function withDraft(drafts: Drafts, key: string, text: string, at: number): Drafts {
  const next = { ...drafts };
  if (text === "") delete next[key];
  else next[key] = { text, at };
  return next;
}

/** The map without drafts untouched for longer than `maxAge`. */
export function pruneDrafts(drafts: Drafts, now: number, maxAge = DRAFT_MAX_AGE_MS): Drafts {
  return Object.fromEntries(Object.entries(drafts).filter(([, d]) => now - d.at <= maxAge));
}

// ---------------------------------------------------------------- localStorage

const STORAGE_KEY = "nexus.drafts";

function load(): Drafts {
  try { return parseDrafts(localStorage.getItem(STORAGE_KEY)); } catch { return {}; }
}

function save(drafts: Drafts): void {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch { /* storage full or blocked: the draft lives only as long as the page */ }
}

export const readDraft = (key: string): string => load()[key]?.text ?? "";
export const writeDraft = (key: string, text: string): void => save(withDraft(load(), key, text, Date.now()));
export const clearDraft = (key: string): void => writeDraft(key, "");
/** Told when a draft is put from elsewhere (putDraft), so that an open box with that draft shows it. */
export const DRAFT_EVENT = "nexus:draft";
/** Writes a draft from outside its box ("Ask the orchestrator…" puts a reference in the composer); an open box follows. */
export const putDraft = (key: string, text: string): void => {
  writeDraft(key, text);
  try { window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: key })); } catch { /* no window */ }
};
export const pruneStoredDrafts = (): void => {
  const all = load();
  const kept = pruneDrafts(all, Date.now());
  if (Object.keys(kept).length !== Object.keys(all).length) save(kept);
};

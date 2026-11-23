// A conversation's own model and effort (queue CM; docs/ux/conversation-settings.md): what the editor under a chat's
// header shows and sends. The server checks the pair again before it writes (apps/server/src/conversations.ts, update).
import type { ConversationSettings, ModelInfo } from "@nexus/protocol";
import { effortLevels } from "./efforts.ts";
import { t } from "./i18n.ts";

/** The editor's draft: each field its own value, or "" for the inherited one. */
export interface PairDraft { model: string; effort: string }

/** The draft a conversation's own values give: what it saved, "" where it follows the default. */
export function draftOf(own: { model?: string | null; effort?: string | null }): PairDraft {
  return { model: own.model ?? "", effort: own.effort ?? "" };
}

/** The one PATCH that writes the pair: an inherited field is cleared explicitly (null), never left out. */
export function patchBody(d: PairDraft): { model: string | null; effort: string | null } {
  return { model: d.model.trim() || null, effort: d.effort || null };
}

/** A value as the user reads it: "gpt-6", "gpt-6 (default)", "Runtime default" when the runtime's is not known. */
function valueText(value: string | null, inherited: boolean): string {
  if (value === null) return t("chat.settings.runtimeDefault");
  return inherited ? t("chat.settings.defaulted", { value }) : value;
}

/** "gpt-6 · high (default)": the next turn's pair, each inherited value marked. */
function nextText(s: ConversationSettings): string {
  return `${valueText(s.next.model, s.next.model_from !== "own")} · ${valueText(s.next.effort, s.next.effort_from !== "own")}`;
}

/** "gpt-6 · high": the pair the running process was started with. */
function runningText(r: NonNullable<ConversationSettings["running"]>): string {
  return `${r.model ?? t("chat.settings.runtimeDefault")} · ${r.effort ?? t("chat.settings.runtimeDefault")}`;
}

/**
 * What the compact summary shows: the next turn's pair, and the running one beside it only while a reply runs on
 * another pair (the change applies from the next reply).
 */
export function summaryOf(s: ConversationSettings, working: boolean): { running?: string; next: string } {
  return working && s.running && s.changes ? { running: runningText(s.running), next: nextText(s) } : { next: nextText(s) };
}

/** The label of a selector's inherited choice: "Default (gpt-6)", or "Runtime default" when it is not known. */
export function defaultLabel(value: string | null): string {
  return value === null ? t("chat.settings.runtimeDefault") : t("chat.settings.defaultOf", { value });
}

/**
 * The efforts the editor offers for the draft and whether its pair holds: filtered by the model the draft would run
 * (its own, else the inherited one) where the runtime's own list names that model's levels. Where it does not (the
 * default model unknown, a model the list does not name), the runtime's levels are offered with a note: the runtime
 * checks the pair when it starts. `issue`: the effort the draft would run is not one the model takes (Save waits).
 */
export function effortCheck(runtime: "claude" | "codex", models: readonly ModelInfo[] | undefined, d: PairDraft, inherited: ConversationSettings["inherited"]):
  { efforts: string[]; issue?: string; note?: string } {
  const model = d.model || inherited.model;
  const effort = d.effort || inherited.effort;
  const levels = effortLevels(runtime, models);
  if (!model) return { efforts: levels, note: t("chat.settings.modelUnknown") };
  const m = models?.find((x) => x.value === model);
  if (!m?.efforts?.length) return { efforts: levels, ...(models ? { note: t("chat.settings.effortsUnknown", { model }) } : {}) };
  return { efforts: m.efforts, ...(effort && !m.efforts.includes(effort) ? { issue: t("chat.settings.unsupported", { model: m.label, efforts: m.efforts.join(", ") }) } : {}) };
}

/** Whether the draft differs from what the conversation saved (Save has something to write). */
export function changed(d: PairDraft, own: { model?: string | null; effort?: string | null }): boolean {
  const saved = draftOf(own);
  return d.model.trim() !== saved.model || d.effort !== saved.effort;
}

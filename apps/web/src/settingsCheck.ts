// What the settings form refuses to save (queue MX): a stop condition left empty, and a send-back limit that is not a
// whole number of zero or more. The schema takes any text as a stop condition, so the form is where an empty one is
// stopped; the number the server would refuse too, the form says so first. Pure, unit tested (test/settingsCheck.test.ts).

export const STOPS = "defaults.stop_conditions";
export const SEND_BACKS = "defaults.review_send_back_limit";

/** Why the form cannot be saved: the first empty stop condition (1-based), or the send-back limit. */
export type SettingsProblem = { kind: "emptyCondition"; n: number } | { kind: "badLimit" };

/** A stop condition list as the form holds it: the texts, whatever came (a missing list is none). */
export const conditionList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : []);

/** The list as it is saved: each condition trimmed. */
export const savedConditions = (v: unknown): string[] => conditionList(v).map((c) => c.trim());

/**
 * What stops a save of `values` (the form's values by setting key), looking only at `keys`: the settings being saved
 * (on a project's page those that are its own; a following one shows the global value, which was checked there).
 */
export function settingsProblem(values: Record<string, unknown>, keys: readonly string[]): SettingsProblem | undefined {
  if (keys.includes(STOPS)) {
    const empty = conditionList(values[STOPS]).findIndex((c) => !c.trim());
    if (empty >= 0) return { kind: "emptyCondition", n: empty + 1 };
  }
  if (keys.includes(SEND_BACKS)) {
    const n = values[SEND_BACKS];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return { kind: "badLimit" };
  }
  return undefined;
}

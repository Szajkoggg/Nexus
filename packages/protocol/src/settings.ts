// Global settings that projects follow, with a per-setting override (PROTOCOL.md, "Global settings"). Pure: the files
// are read and written by the store (store.ts); the global file only by the server.
import { GlobalSettings, ProjectFile, StoredProject } from "./schemas.ts";

/**
 * Every setting that is global with a project override, by its path in project.yaml (and in the global file).
 * `none`: the setting has no default, so a project's own "none" is stored as null.
 */
export const OVERRIDABLE: readonly { path: readonly string[]; none?: true }[] = [
  ...["stop_conditions", "review_level", "review_send_back_limit", "context_reuse_threshold", "context_care",
    "protect_nexus", "push_accepted", "provisional_counts", "usage_pause_threshold"].map((k) => ({ path: ["defaults", k] })),
  { path: ["runtimes", "default"] },
  { path: ["runtimes", "claude", "model"], none: true },
  { path: ["runtimes", "claude", "effort"], none: true },
  { path: ["runtimes", "claude", "permission_mode"] },
  { path: ["runtimes", "codex", "model"], none: true },
  { path: ["runtimes", "codex", "effort"], none: true },
  { path: ["runtimes", "codex", "sandbox"] },
  { path: ["runtimes", "codex", "approval_policy"] },
  { path: ["runtimes", "codex", "approvals_reviewer"], none: true },
  { path: ["conversations", "runtime"] },
  { path: ["conversations", "model"], none: true },
  { path: ["conversations", "effort"], none: true },
  { path: ["orchestrator", "runtime"] },
  { path: ["orchestrator", "model"], none: true },
  { path: ["orchestrator", "effort"], none: true },
  { path: ["orchestrator", "notify"] },
  { path: ["languages", "reader"], none: true },
] as const;

/** A setting's path as written in PROTOCOL.md and in an update's `follow` list: `runtimes.claude.model`. */
export const settingKey = (path: readonly string[]) => path.join(".");

type Tree = Record<string, unknown>;
const get = (o: unknown, path: readonly string[]): unknown => path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Tree)[k] : undefined), o);
function set(o: Tree, path: readonly string[], value: unknown): void {
  let x = o;
  for (const k of path.slice(0, -1)) x = (x[k] ??= {}) as Tree;
  const last = path.at(-1)!;
  if (value === undefined) delete x[last]; else x[last] = value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The orchestrator's settings count only for a project that has an orchestrator section (it has had one). */
const applies = (o: Tree, path: readonly string[]) => path[0] !== "orchestrator" || !!o.orchestrator;

/** The built-in defaults: the global settings before anyone changed them. */
export const builtInSettings = (): GlobalSettings => GlobalSettings.parse({ protocol: 1 });

/** The keys of the settings the project has its own value of (the others follow the global ones). */
export function ownKeys(stored: StoredProject): string[] {
  return OVERRIDABLE.filter(({ path }) => get(stored, path) !== undefined).map(({ path }) => settingKey(path));
}

/**
 * The global settings with a change: a value given replaces the one there, null or "" clears an optional one (none:
 * the runtime's default). Checked against the schema; the caller writes the result.
 */
export function changedGlobal(global: GlobalSettings, patch: unknown): GlobalSettings {
  const out = structuredClone(global) as Tree;
  const walk = (into: Tree, p: unknown) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return;
    for (const [k, v] of Object.entries(p as Tree)) {
      if (v === null || v === "") delete into[k];
      else if (typeof v === "object" && !Array.isArray(v)) walk((into[k] ??= {}) as Tree, v);
      else into[k] = v;
    }
  };
  walk(out, patch);
  out.protocol = 1;
  return GlobalSettings.parse(out);
}

/** Whether the project has its own value of a setting (else it follows the global one). */
export function hasOwn(stored: StoredProject, path: readonly string[]): boolean {
  return get(stored, path) !== undefined;
}

/** A project's effective settings: its own value of each setting where it has one, else the global value. */
export function effectiveProject(stored: StoredProject, global: GlobalSettings): ProjectFile {
  const out = structuredClone(stored) as Tree;
  delete out.follows_global;
  for (const { path } of OVERRIDABLE) {
    if (!applies(out, path)) continue;
    const own = get(stored, path);
    set(out, path, own === undefined ? get(global, path) : own === null ? undefined : own);
  }
  return ProjectFile.parse(out);
}

/**
 * Stores effective settings: a value equal to the global one follows it (no value of its own), a different one becomes
 * the project's own (null for "none"). The migration's rule; also what writeProject does with a whole project.
 */
export function storedFrom(effective: ProjectFile, global: GlobalSettings): StoredProject {
  const out = structuredClone(effective) as Tree;
  out.follows_global = true;
  for (const { path } of OVERRIDABLE) {
    if (!applies(out, path)) continue;
    const value = get(effective, path);
    set(out, path, same(value, get(global, path)) ? undefined : value === undefined ? null : value);
  }
  return StoredProject.parse(out);
}

/**
 * Applies a change of effective values to the stored settings, keeping "follows" and "own value" apart: a setting the
 * change gives another effective value becomes the project's own (null for "none"); one it leaves as it is keeps its
 * state, following or own. `follow`: settings (by key, `runtimes.claude.model`) that follow the global value again,
 * whatever the change says about them. `own`: settings that become the project's own with the value `next` gives, also
 * when it equals the global one. Project-only settings and state are taken from `next` as they are.
 */
export function applyChange(stored: StoredProject, global: GlobalSettings, next: ProjectFile, follow: readonly string[] = [], own: readonly string[] = []): StoredProject {
  const unknown = [...follow, ...own].filter((k) => !OVERRIDABLE.some((x) => settingKey(x.path) === k));
  if (unknown.length) throw new Error(`not a setting with a global value: ${unknown.join(", ")}`);
  const both = follow.filter((k) => own.includes(k));
  if (both.length) throw new Error(`a setting either follows or is the project's own, not both: ${both.join(", ")}`);
  // A project that gets its orchestrator section now: the section's settings were the global ones until now.
  const before = effectiveProject({ ...stored, orchestrator: stored.orchestrator ?? { session: null } }, global);
  const out = structuredClone(next) as Tree;
  out.follows_global = true;
  for (const { path } of OVERRIDABLE) {
    if (!applies(out, path)) continue;
    const value = get(next, path);
    if (follow.includes(settingKey(path))) set(out, path, undefined);
    else if (own.includes(settingKey(path)) || !same(value, get(before, path))) set(out, path, value === undefined ? null : value);
    else set(out, path, get(stored, path)); // unchanged: following stays following, own stays own
  }
  return StoredProject.parse(out);
}

/**
 * The migration of one project.yaml from before global settings (no `follows_global`), as read from the file: its
 * values meant what the built-in defaults made of them; each that equals the global value now follows it, each that
 * differs becomes the project's own. Its effective settings do not change. Undefined for a file already migrated.
 */
export function migrateStored(raw: unknown, global: GlobalSettings): StoredProject | undefined {
  if (raw && typeof raw === "object" && (raw as Tree).follows_global === true) return undefined;
  return storedFrom(ProjectFile.parse(raw), global);
}

// The capture tool's pure parts (unit tested in scripts/test/capture.test.ts): the view list, the environment of the
// development instance it starts, the base commit of a step, and what it reports.
import YAML from "yaml";
import { VIEW_KEY, splitKey } from "@nexus/protocol/pictures";

/** One thing done in the page before the picture is taken. */
export type Action =
  | { click: string | { selector: string } }      // a button, link or tab by its text; or the first element matching a CSS selector
  | { type: { text: string; into?: string } }     // typed into the element matching `into` (a CSS selector), else the focused one
  | { press: string }                             // a key, e.g. Escape, Enter, ArrowRight
  | { wait: number };                             // milliseconds

/** One picture: its key (subject-state@width), the dashboard route, and the setup. */
export interface View {
  key: string;
  /** The dashboard's address after the host: a hash route like "#/demo/UI/UI1". */
  route: string;
  /** The caption for `nexus review add --label`; default: the key. */
  label?: string;
  /** The window's height in CSS pixels; default 900 from 1024 px wide, else 844. */
  height?: number;
  /** How long the page settles after it opens, in milliseconds (default 1500). */
  settle?: number;
  actions: Action[];
  /** From the key. */
  width: number;
}

export interface ViewList {
  /** A script that writes the test projects: run as `node <seed> <data dir>` with NEXUS_HOME set; path from the repository root. */
  seed?: string;
  views: View[];
}

/** Parses and checks a view list (YAML or JSON); throws with every problem found, each with where it is. */
export function parseViews(text: string): ViewList {
  let doc: unknown;
  try { doc = YAML.parse(text); } catch (e) { throw new Error(`the view list is not valid YAML: ${(e as Error).message}`); }
  const problems: string[] = [];
  const root = (doc ?? {}) as { seed?: unknown; views?: unknown };
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("the view list is a mapping with `views:` (and optionally `seed:`)");
  if (root.seed !== undefined && (typeof root.seed !== "string" || !root.seed)) problems.push("seed: a path to a script");
  if (!Array.isArray(root.views) || !root.views.length) problems.push("views: a list of at least one view");
  const views: View[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of (Array.isArray(root.views) ? root.views : []).entries()) {
    const at = `views[${i}]`;
    const v = (raw ?? {}) as Record<string, unknown>;
    const key = v.key;
    if (typeof key !== "string" || !VIEW_KEY.test(key)) { problems.push(`${at}.key: a view key, e.g. waiting-tab@492 (lowercase words joined by hyphens, @ and the width)`); continue; }
    if (seen.has(key)) problems.push(`${at}.key: ${key} twice`);
    seen.add(key);
    if (typeof v.route !== "string" || !v.route.startsWith("#/")) problems.push(`${at} (${key}).route: a dashboard route starting with #/, e.g. "#/demo/UI/UI1"`);
    if (v.label !== undefined && typeof v.label !== "string") problems.push(`${at} (${key}).label: text`);
    for (const f of ["height", "settle"] as const) {
      if (v[f] !== undefined && !(Number.isInteger(v[f]) && (v[f] as number) >= 0)) problems.push(`${at} (${key}).${f}: a whole number of ${f === "height" ? "pixels" : "milliseconds"}`);
    }
    const actions: Action[] = [];
    if (v.actions !== undefined && !Array.isArray(v.actions)) problems.push(`${at} (${key}).actions: a list`);
    for (const [j, a] of (Array.isArray(v.actions) ? v.actions : []).entries()) {
      const p = actionProblem(a);
      if (p) problems.push(`${at} (${key}).actions[${j}]: ${p}`);
      else actions.push(a as Action);
    }
    const width = splitKey(key).width;
    views.push({
      key, route: v.route as string, label: v.label as string | undefined, actions, width,
      height: (v.height as number | undefined) ?? (width >= 1024 ? 900 : 844), settle: (v.settle as number | undefined) ?? 1500,
    });
  }
  if (problems.length) throw new Error(`the view list has ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
  return { seed: root.seed as string | undefined, views };
}

function actionProblem(a: unknown): string | undefined {
  const usage = "one of click: <text> | click: {selector}, type: {text, into?}, press: <key>, wait: <ms>";
  if (typeof a !== "object" || a === null || Array.isArray(a) || Object.keys(a).length !== 1) return usage;
  const [kind, value] = Object.entries(a)[0]!;
  if (kind === "click") {
    if (typeof value === "string" && value) return undefined;
    if (typeof value === "object" && value && typeof (value as { selector?: unknown }).selector === "string") return undefined;
    return "click: the text of a button, link or tab, or {selector: <css>}";
  }
  if (kind === "type") {
    const t = value as { text?: unknown; into?: unknown } | null;
    return t && typeof t === "object" && typeof t.text === "string" && (t.into === undefined || typeof t.into === "string") ? undefined : "type: {text: <text>, into?: <css>}";
  }
  if (kind === "press") return typeof value === "string" && value ? undefined : "press: a key name, e.g. Escape";
  if (kind === "wait") return Number.isInteger(value) && (value as number) >= 0 ? undefined : "wait: milliseconds";
  return usage;
}

/** What a session's environment may carry that must not reach the instance: it would act on the real project or the live instance. */
export const CLEARED = ["NEXUS_DIR", "NEXUS_HANDOVER", "NEXUS_SESSION"] as const;

/**
 * The development instance's environment: the parent's without NEXUS_DIR, NEXUS_HANDOVER and NEXUS_SESSION, with its
 * own NEXUS_HOME and port, and the fake runtimes for Claude Code and Codex, so it can never start a real agent.
 */
export function instanceEnv(parent: NodeJS.ProcessEnv, o: { home: string; port: number; fakes: { claude: string; codex: string } }): NodeJS.ProcessEnv {
  if (o.port === 4317) throw new Error("port 4317 is the live instance's; the capture tool uses 4318 and above");
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const k of CLEARED) delete env[k];
  delete env.NEXUS_HOST;
  return { ...env, NEXUS_HOME: o.home, NEXUS_PORT: String(o.port), NEXUS_CLAUDE: o.fakes.claude, NEXUS_CODEX: o.fakes.codex };
}

/** The commit a step started from: its first start in queues/<queue>/git.yaml. */
export function baseOf(gitYaml: string, step: string): string | undefined {
  const doc = YAML.parse(gitYaml) as { steps?: Record<string, { start?: string | null }[]> } | null;
  return doc?.steps?.[step]?.[0]?.start ?? undefined;
}

/** What became of one view on one side: the picture's path, or why there is none. */
export interface Shot { key: string; side: "before" | "after"; file?: string; error?: string }

/** The picture's file name: <key>.png, the before <key>.before.png. */
export const shotFile = (key: string, side: "before" | "after") => `${key}${side === "before" ? ".before" : ""}.png`;

/**
 * The report: what was taken, what was not and why (to be taken by hand under the same conditions, and said in the
 * step summary), and the `nexus review add` commands for what was taken, befores first. With no before run, the
 * pictures are results.
 */
export function report(views: View[], shots: Shot[], o: { step?: string; base?: string; beforeRun: boolean; notes?: string[] }): string {
  const lines: string[] = [];
  const failed = shots.filter((s) => s.error);
  lines.push(`capture: ${shots.length - failed.length} of ${shots.length} picture(s) taken${o.base ? ` (befores at ${o.base.slice(0, 7)})` : ""}`);
  for (const n of o.notes ?? []) lines.push(`note: ${n}`);
  for (const s of failed) lines.push(`NOT TAKEN: ${s.key} ${s.side}: ${s.error}`);
  if (failed.length) lines.push("Take those by hand under the same conditions (window size, data, state), and say so in the step summary.");
  const step = o.step ?? "<step>";
  const q = (t: string) => `"${t.replaceAll('"', "'")}"`;
  const add: string[] = [];
  for (const v of views) {
    const before = shots.find((s) => s.key === v.key && s.side === "before" && s.file);
    const after = shots.find((s) => s.key === v.key && s.side === "after" && s.file);
    const label = v.label ?? v.key;
    if (before) add.push(`nexus review add ${step} ${before.file} --key ${v.key} --role before --label ${q(`${label}, before`)}`);
    if (after) add.push(`nexus review add ${step} ${after.file} --key ${v.key} --role ${o.beforeRun ? "after" : "result"} --label ${q(label)}`);
  }
  // Befores first: an after is refused without its before.
  add.sort((a, b) => Number(a.includes("--role before") ? 0 : 1) - Number(b.includes("--role before") ? 0 : 1));
  if (add.length) lines.push("", "Register them (see nexus help review):", ...add);
  return lines.join("\n");
}

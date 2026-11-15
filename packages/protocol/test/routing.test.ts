// What a step runs on (routing.ts; PROTOCOL.md, "Kinds and their defaults"): every level of the precedence (step,
// queue, the start's explicit values, the kind's project and global defaults, the project's defaults), a start with
// --model X and a mechanical step, a kind on another runtime than an explicit start's, the fallback chain from the
// strongest level, and bad fallback entries refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlobalSettings, ProjectStore, SHIPPED_KIND_DEFAULTS, applyDraft, builtInSettings, effectiveProject, fallbackIssues, kindDefaults,
  routeStep, updateGlobalSettings, updateSettings, type ProjectFile, type StartValues,
} from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-routing-"));
  process.env.NEXUS_HOME = join(root, "home");
  return ProjectStore.init(root, { id: "p", name: "P", root, runtimes: { claude: { model: "proj-claude", effort: "medium" }, codex: { model: "proj-codex", effort: "low" } } });
}

/** A start that named nothing: the project's defaults. */
const fromDefaults = (p: ProjectFile): StartValues => ({ runtime: p.runtimes.default, model: p.runtimes.claude.model, effort: p.runtimes.claude.effort, explicit: [] });
const values = (r: ReturnType<typeof routeStep>) => [r.runtime, r.model, r.effort];

test("every level of the precedence, strongest first: step, queue, the start's explicit values, the kind (project, then global), the project", () => {
  const store = setup();
  updateGlobalSettings({ kinds: { code: { model: "global-code", effort: "high" } } });
  let p = store.readProject();
  const kind = kindDefaults(p, "code");
  const start = fromDefaults(p);
  // The project's defaults: no kind, nothing named.
  assert.deepEqual(values(routeStep({ step: {}, queue: {}, start, project: p })), ["claude", "proj-claude", "medium"]);
  // The kind's global defaults go over the project's.
  let r = routeStep({ step: {}, queue: {}, start, kind, project: p });
  assert.deepEqual([...values(r), r.from.model], ["claude", "global-code", "high", "kind"]);
  // The project's own value of the kind goes over the global one.
  updateSettings(store, { kinds: { code: { model: "project-code" } } });
  p = store.readProject();
  r = routeStep({ step: {}, queue: {}, start, kind: kindDefaults(p, "code"), project: p });
  assert.deepEqual(values(r), ["claude", "project-code", "high"]);
  // An explicit start goes over the kind.
  r = routeStep({ step: {}, queue: {}, start: { ...start, model: "started", explicit: ["model"] }, kind: kindDefaults(p, "code"), project: p });
  assert.deepEqual([...values(r), r.from.model, r.from.effort], ["claude", "started", "high", "start", "kind"]);
  // The queue goes over the start; the step over the queue.
  r = routeStep({ step: {}, queue: { model: "queued", effort: "low" }, start: { ...start, model: "started", explicit: ["model"] }, kind: kindDefaults(p, "code"), project: p });
  assert.deepEqual(values(r), ["claude", "queued", "low"]);
  r = routeStep({ step: { model: "stepped" }, queue: { model: "queued", effort: "low" }, start, kind: kindDefaults(p, "code"), project: p });
  assert.deepEqual([...values(r), r.from.model, r.from.effort], ["claude", "stepped", "low", "step", "queue"]);
  // A step on another runtime: what it does not name is that runtime's (the queue's Claude values do not fit it).
  r = routeStep({ step: { runtime: "codex" }, queue: { runtime: "claude", model: "queued" }, start, kind: kindDefaults(p, "code"), project: p });
  assert.deepEqual(values(r), ["codex", "proj-codex", "low"]);
});

test("a run started with --model X: a mechanical step runs on X (the kind goes only over what the start took from the defaults)", () => {
  const p = setup().readProject();
  const kind = kindDefaults(p, "mechanical");
  assert.deepEqual(kind, SHIPPED_KIND_DEFAULTS.mechanical);
  const r = routeStep({ step: {}, queue: {}, start: { runtime: "claude", model: "X", effort: "medium", explicit: ["model"] }, kind, project: p });
  assert.deepEqual([...values(r), r.from.runtime, r.from.effort], ["claude", "X", "low", "kind", "kind"], "the model the start named; the runtime and effort the kind's");
  // Without --model: the kind's model.
  assert.deepEqual(values(routeStep({ step: {}, queue: {}, start: fromDefaults(p), kind, project: p })), ["claude", "claude-sonnet-5-5", "low"]);
});

test("a kind on another runtime than the start's explicit one leaves the run's values", () => {
  const store = setup();
  updateGlobalSettings({ kinds: { docs: { runtime: "codex", model: "codex-docs", effort: "high", fallback: [] } } });
  const p = store.readProject();
  const kind = kindDefaults(p, "docs");
  const r = routeStep({ step: {}, queue: {}, start: { runtime: "claude", model: "opus", effort: "max", explicit: ["runtime", "model", "effort"] }, kind, project: p });
  assert.deepEqual([...values(r), r.from.model], ["claude", "opus", "max", "start"]);
  // Only --runtime claude: the model and effort are the project's for Claude, not the Codex kind's.
  const only = routeStep({ step: {}, queue: {}, start: { runtime: "claude", model: "proj-claude", effort: "medium", explicit: ["runtime"] }, kind, project: p });
  assert.deepEqual(values(only), ["claude", "proj-claude", "medium"]);
  // Without an explicit runtime, the kind's runtime and values.
  assert.deepEqual(values(routeStep({ step: {}, queue: {}, start: fromDefaults(p), kind, project: p })), ["codex", "codex-docs", "high"]);
});

test("the fallback chain comes from the strongest level that names one; the shipped defaults pass the checks", () => {
  const p = setup().readProject();
  const kind = kindDefaults(p, "code");
  const start = fromDefaults(p);
  const route = (step: object, queue: object) => routeStep({ step, queue, start, kind, project: p });
  assert.deepEqual([route({}, {}).fallback, route({}, {}).from.fallback], [[{ runtime: "codex", effort: "high" }], "kind"]);
  assert.deepEqual(route({}, { fallback: ["wait"] }).fallback, ["wait"]);
  assert.deepEqual(route({ fallback: [{ runtime: "claude", model: "haiku" }] }, { fallback: ["wait"] }).fallback, [{ runtime: "claude", model: "haiku" }]);
  assert.deepEqual(route({ fallback: [] }, { fallback: ["wait"] }).fallback, [], "an empty list is a choice too");
  assert.deepEqual(routeStep({ step: {}, queue: {}, start, project: p }).fallback, [], "no kind, nothing named: none");
  assert.deepEqual(kindDefaults(p, "design")?.fallback, ["wait"]);
  for (const [k, d] of Object.entries(SHIPPED_KIND_DEFAULTS)) assert.deepEqual(fallbackIssues(d.fallback), [], k);
  assert.deepEqual(GlobalSettings.parse({ protocol: 1 }).kinds, SHIPPED_KIND_DEFAULTS, "a settings file without kinds reads the shipped ones");
  assert.equal(kindDefaults(p, "frobnicate"), undefined);
});

test("a bad fallback entry is refused: in a draft, and in the settings", () => {
  const store = setup();
  const draft = (extra: Record<string, unknown>, step: Record<string, unknown> = {}) => ({ id: "Q", title: "Q", ...extra, steps: [{ id: "Q1", title: "One", ...step }] });
  const refused = (def: unknown) => { try { applyDraft(store, def); } catch (e) { return (e as Error).message; } return "accepted"; };
  assert.match(refused(draft({}, { fallback: [{ runtime: "claude", effort: "ultra" }] })), /step Q1: fallback entry 1 \(claude at effort ultra\): Claude Code takes effort/);
  assert.match(refused(draft({ fallback: ["wait", { runtime: "codex" }] })), /queue Q: fallback entry 2 comes after wait/);
  assert.match(refused(draft({}, { fallback: [{ runtime: "gemini" }] })), /fallback/);
  assert.match(refused(draft({}, { fallback: [{ runtime: "codex", modell: "x" }] })), /fallback/, "an unknown key in an entry");
  assert.match(refused(draft({ runtime: "claude", effort: "ultra" })), /queue Q: Claude Code takes effort/);
  assert.equal(refused(draft({ runtime: "codex", model: "m", effort: "ultra", fallback: [{ runtime: "claude", model: "haiku", effort: "low" }, "wait"] }, { fallback: [] })), "accepted");
  assert.throws(() => updateGlobalSettings({ kinds: { code: { effort: "ultra" } } }), /kind code: Claude Code takes effort/);
  assert.throws(() => updateSettings(store, { kinds: { docs: { fallback: ["wait", "wait"] } } }), /kind docs: fallback entry 2 comes after wait/);
  assert.deepEqual(builtInSettings().kinds.code, SHIPPED_KIND_DEFAULTS.code, "nothing was written");
});

test("a project follows the global kinds until it has its own value; null is its own 'none' (the runtime's model)", () => {
  const store = setup();
  updateSettings(store, { kinds: { research: { model: null } } });
  const stored = store.readStoredProject();
  assert.equal(stored.kinds?.research?.model, null);
  const p = effectiveProject(stored, builtInSettings());
  assert.deepEqual([p.kinds.research.runtime, p.kinds.research.model, p.kinds.research.effort], ["claude", undefined, "high"]);
  assert.deepEqual(values(routeStep({ step: {}, queue: {}, start: fromDefaults(p), kind: kindDefaults(p, "research"), project: p })), ["claude", "proj-claude", "high"]);
  updateSettings(store, { follow: ["kinds.research.model"] });
  assert.equal(store.readProject().kinds.research.model, "claude-opus-5-5", "follows the global value again");
});

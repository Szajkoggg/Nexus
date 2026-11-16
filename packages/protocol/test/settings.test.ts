// Global settings that projects follow, with a per-setting override (src/settings.ts, the store's project methods).
// The migration runs on copies of real-shaped project.yaml files (this project's and Project Honeycomb's of
// 2026-11-14, with their roots replaced).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  ActionError, ProjectFile, ProjectStore, builtInSettings, effectiveProject, ownKeys, readGlobalSettings, updateGlobalSettings, updateSettings, writeGlobalSettings,
  type GlobalSettings, type StoredProject,
} from "../src/index.ts";

const NEXUS_SHAPE = (root: string) => `protocol: 1
id: nexus
name: Nexus
root: ${root}
defaults:
  stop_conditions: []
  review_policy: continue
  review_send_back_limit: 2
  context_reuse_threshold: 0.7
  context_care: true
  protect_nexus: true
  push_accepted: false
  usage_pause_threshold: 0.9
runtimes:
  default: claude
  claude:
    effort: high
    permission_mode: auto
    allowed_tools: []
  codex:
    sandbox: workspace-write
    approval_policy: on-request
    approvals_reviewer: auto_review
conversations:
  notes_dir: docs/ideas
  runtime: claude
orchestrator:
  runtime: claude
  session: 01M78S3GZCG4CR2BXHRZGHAEBM
  notify: true
`;

const HONEYCOMB_SHAPE = (root: string) => `protocol: 1
id: honeycomb
name: Project Honeycomb
root: ${root}
defaults:
  stop_conditions:
    - A decision comes up that is the user's (the look, gameplay, a final number)
    - An asset is missing
    - A step would grow beyond what is written here
    - The rules the world must keep would change (plan format, anchors, seams)
    - A check that passed before the queue fails and is not fixed within the step
  review_policy: continue
  review_send_back_limit: 2
  context_reuse_threshold: 0.7
  context_care: true
  protect_nexus: true
  push_accepted: true
  usage_pause_threshold: 0.85
runtimes:
  default: claude
  claude:
    permission_mode: auto
    allowed_tools: []
  codex:
    sandbox: workspace-write
    approval_policy: on-request
    approvals_reviewer: auto_review
conversations:
  notes_dir: Dev/Concepts/Gameplay
  runtime: claude
orchestrator:
  runtime: claude
  session: 01M79W5M3H06807YWQ26X1595B
  effort: high
  notify: true
`;

/** A fresh NEXUS_HOME, and a project whose project.yaml is `text` (a file from before global settings). */
function legacy(shape: (root: string) => string) {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project").replaceAll("\\", "/");
  mkdirSync(join(root, ".nexus"), { recursive: true });
  const text = shape(root);
  writeFileSync(join(root, ".nexus", "project.yaml"), text);
  const store = ProjectStore.forRoot(root);
  return { store, text, file: join(root, ".nexus", "project.yaml"), stored: () => YAML.parse(readFileSync(join(root, ".nexus", "project.yaml"), "utf8")) as StoredProject };
}

/**
 * What a project.yaml from before global settings meant: its values, the built-in defaults for the rest, and the
 * settings added since it was written (the orchestrator's context threshold) at their built-in values.
 */
const meant = (text: string): ProjectFile => {
  const p = ProjectFile.parse(YAML.parse(text));
  return p.orchestrator ? { ...p, orchestrator: { ...p.orchestrator, context_threshold: builtInSettings().orchestrator.context_threshold } } : p;
};
const globalWith = (change: (g: GlobalSettings) => void): GlobalSettings => { const g = builtInSettings(); change(g); return g; };

test("the effective value is the project's own where it has one, else the global one; null is its own 'none'", () => {
  const g = globalWith((x) => { x.defaults.review_level = 1; x.runtimes.claude.model = "opus"; x.runtimes.codex.model = "gpt-6-astra"; x.orchestrator.notify = false; });
  const stored: StoredProject = {
    protocol: 1, id: "p", name: "P", root: "C:/p", follows_global: true,
    defaults: { context_reuse_threshold: 0.7, worktree_dir: "C:/w" },
    runtimes: { claude: { effort: "high", allowed_tools: ["WebFetch"] }, codex: { model: null, mcp_servers: [] } },
    conversations: { notes_dir: "notes" },
    languages: {},
  };
  const p = effectiveProject(stored, g);
  assert.equal(p.defaults.review_level, 1, "follows the global value");
  assert.equal(p.defaults.context_reuse_threshold, 0.7, "its own value");
  assert.equal(p.defaults.worktree_dir, "C:/w", "project only");
  assert.equal(p.runtimes.claude.model, "opus");
  assert.equal(p.runtimes.claude.effort, "high");
  assert.equal(p.runtimes.codex.model, undefined, "its own 'none' (the runtime's default) wins over the global model");
  assert.deepEqual(p.runtimes.claude.allowed_tools, ["WebFetch"]);
  assert.equal(p.conversations.notes_dir, "notes");
  assert.equal(p.orchestrator, undefined, "no orchestrator section: none is made up");
  const withOrch = effectiveProject({ ...stored, orchestrator: { session: "s1" } }, g);
  assert.deepEqual([withOrch.orchestrator?.session, withOrch.orchestrator?.notify, withOrch.orchestrator?.runtime], ["s1", false, "claude"]);
  assert.ok(ProjectFile.safeParse(p).success);
});

test("a changed setting becomes the project's own, an untouched one keeps following, and follow switches an override off", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  const stored = () => store.readStoredProject();
  assert.equal(stored().follows_global, true);
  assert.equal(stored().defaults.review_level, undefined, "a new project follows every global setting");

  updateSettings(store, { defaults: { review_level: 1 }, runtimes: { claude: { model: "sonnet" } } });
  assert.deepEqual([stored().defaults.review_level, stored().runtimes.claude.model], [1, "sonnet"]);
  assert.equal(stored().defaults.usage_pause_threshold, undefined, "untouched: still follows");

  // A whole settings form sent back unchanged (as the dashboard does) changes nothing: following stays following.
  updateSettings(store, { defaults: { ...store.readProject().defaults, review_level: 1 } });
  assert.equal(stored().defaults.usage_pause_threshold, undefined);
  assert.equal(stored().defaults.review_level, 1);

  // The global value changes: a following project follows it at once; one with its own value keeps it.
  writeGlobalSettings(globalWith((x) => { x.defaults.usage_pause_threshold = 0.8; x.defaults.review_level = 3; }));
  assert.equal(store.readProject().defaults.usage_pause_threshold, 0.8);
  assert.equal(store.readProject().defaults.review_level, 1);

  // Clearing an optional setting is its own "none", not following.
  updateSettings(store, { runtimes: { claude: { model: null } } });
  assert.equal(stored().runtimes.claude.model, null);
  assert.equal(store.readProject().runtimes.claude.model, undefined);

  // Switching the overrides off: they follow the global value again.
  updateSettings(store, { follow: ["defaults.review_level", "runtimes.claude.model"] });
  assert.deepEqual([stored().defaults.review_level, stored().runtimes.claude.model], [undefined, undefined]);
  assert.equal(store.readProject().defaults.review_level, 3);
  assert.throws(() => updateSettings(store, { follow: ["conversations.notes_dir"] }), (e: Error) => e instanceof ActionError && /not a setting with a global value: conversations.notes_dir/.test(e.message));

  // The orchestrator's section made later (its session) follows the global settings too.
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: "s1" } }));
  assert.deepEqual(stored().orchestrator, { session: "s1" });
});

test("the orchestrator's runtime: Claude Code by default, the project's own from its settings page, and following the global one again (queue OC)", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  // As the dashboard's project page sends it: the runtime with the model and effort it clears.
  updateSettings(store, { orchestrator: { runtime: "codex", model: "", effort: "ultra" }, own: ["orchestrator.runtime"] });
  assert.equal(store.readProject().orchestrator?.runtime, "codex");
  assert.equal(store.readProject().orchestrator?.effort, "ultra", "Codex's levels are the orchestrator's too");
  assert.equal(store.readStoredProject().orchestrator?.runtime, "codex");
  assert.throws(() => updateSettings(store, { orchestrator: { runtime: "gemini" } }), /orchestrator.runtime/);
  updateSettings(store, { follow: ["orchestrator.runtime"] });
  assert.equal(store.readProject().orchestrator?.runtime, "claude", "the global value again");
});

test("the MCP servers Codex workers keep: none by default, the project's only, kept when other settings change", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  assert.deepEqual(store.readProject().runtimes.codex.mcp_servers, []);
  // As the dashboard's project page sends it: the list beside the Codex settings.
  updateSettings(store, { runtimes: { codex: { mcp_servers: ["blender"] } } });
  assert.deepEqual(store.readStoredProject().runtimes.codex.mcp_servers, ["blender"]);
  updateSettings(store, { runtimes: { codex: { sandbox: "read-only" } } });
  assert.deepEqual(store.readProject().runtimes.codex.mcp_servers, ["blender"], "another Codex setting leaves it");
  assert.throws(() => updateSettings(store, { follow: ["runtimes.codex.mcp_servers"] }), /not a setting with a global value/);
  updateSettings(store, { runtimes: { codex: { mcp_servers: [] } } });
  assert.deepEqual(store.readProject().runtimes.codex.mcp_servers, []);
  assert.throws(() => updateSettings(store, { runtimes: { codex: { mcp_servers: "blender" } } }), /mcp_servers/);
});

test("merging back by itself and resolving conflicts: off by default, global with a project override; the worktree setup command is the project's only", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  const stored = () => store.readStoredProject();
  const effective = () => store.readProject().defaults;
  assert.deepEqual([builtInSettings().defaults.merge_back, builtInSettings().defaults.resolve_conflicts], [false, false], "built-in: off");
  assert.deepEqual([effective().merge_back, effective().resolve_conflicts, effective().worktree_setup], [false, false, undefined], "a new project: off, no setup command");
  assert.deepEqual([stored().defaults.merge_back, stored().defaults.resolve_conflicts], [undefined, undefined], "it follows the global values");

  // The project turns them on: its own values, whatever the global ones.
  updateSettings(store, { defaults: { merge_back: true, resolve_conflicts: true, worktree_setup: "npm ci" } });
  assert.deepEqual([stored().defaults.merge_back, stored().defaults.resolve_conflicts, stored().defaults.worktree_setup], [true, true, "npm ci"]);
  assert.deepEqual(ownKeys(stored()).filter((k) => /merge_back|resolve_conflicts|worktree_setup/.test(k)), ["defaults.merge_back", "defaults.resolve_conflicts"], "the setup command is not a global setting");
  writeGlobalSettings(globalWith((x) => { x.defaults.merge_back = false; x.defaults.resolve_conflicts = true; }));
  assert.deepEqual([effective().merge_back, effective().resolve_conflicts], [true, true]);

  // Following again: the global values.
  updateSettings(store, { follow: ["defaults.merge_back", "defaults.resolve_conflicts"] });
  assert.deepEqual([stored().defaults.merge_back, stored().defaults.resolve_conflicts], [undefined, undefined]);
  assert.deepEqual([effective().merge_back, effective().resolve_conflicts], [false, true]);
  assert.throws(() => updateSettings(store, { follow: ["defaults.worktree_setup"] }), (e: Error) => e instanceof ActionError && /not a setting with a global value/.test(e.message));
  // Clearing the setup command: none.
  updateSettings(store, { defaults: { worktree_setup: null } });
  assert.equal(effective().worktree_setup, undefined);
});

test("the project's checks: the project's only, empty by default, stored trimmed and once each", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  assert.deepEqual(store.readProject().defaults.checks, [], "a new project: none");
  updateSettings(store, { defaults: { checks: ["npm run lint ", "", "npm test", "npm run lint"] } });
  assert.deepEqual(store.readStoredProject().defaults.checks, ["npm run lint", "npm test"]);
  assert.deepEqual(ownKeys(store.readStoredProject()).filter((k) => k.includes("checks")), [], "not a global setting");
  assert.throws(() => updateSettings(store, { follow: ["defaults.checks"] }), (e: Error) => e instanceof ActionError && /not a setting with a global value/.test(e.message));
  updateSettings(store, { defaults: { checks: [] } });
  assert.deepEqual(store.readProject().defaults.checks, []);
});

for (const [name, shape] of [["Nexus", NEXUS_SHAPE], ["Project Honeycomb", HONEYCOMB_SHAPE]] as const) {
  test(`migrating ${name}'s project.yaml: equal values follow, different ones become its own, effective values unchanged, once`, () => {
    const x = legacy(shape);
    const before = meant(x.text); // what the file meant before global settings
    assert.deepEqual(x.store.readProject(), before, "an unmigrated file reads as before");
    assert.equal(x.store.migrateProject(), true);
    const s = x.stored();
    assert.equal(s.follows_global, true);
    // Equal to the built-in global values: following.
    assert.equal(s.defaults.review_level, undefined);
    assert.equal(s.defaults.context_care, undefined);
    assert.equal(s.runtimes.default, undefined);
    assert.equal(s.runtimes.codex.sandbox, undefined);
    assert.equal(s.runtimes.claude.model, undefined);
    assert.equal(s.orchestrator!.notify, undefined);
    // Different: its own.
    assert.equal(s.defaults.context_reuse_threshold, 0.7);
    assert.equal(s.runtimes.claude.permission_mode, "auto");
    assert.equal(s.runtimes.codex.approval_policy, "on-request");
    assert.equal(s.runtimes.codex.approvals_reviewer, "auto_review");
    if (name === "Nexus") assert.equal(s.runtimes.claude.effort, "high");
    else {
      assert.equal(s.defaults.stop_conditions!.length, 5);
      assert.equal(s.defaults.push_accepted, true);
      assert.equal(s.defaults.usage_pause_threshold, 0.85);
      assert.equal(s.orchestrator!.effort, "high");
    }
    // Project only and state: as they were.
    assert.equal(s.conversations.notes_dir, before.conversations.notes_dir);
    assert.equal(s.orchestrator!.session, before.orchestrator!.session);
    assert.deepEqual(x.store.readProject(), before, "effective values unchanged");
    // A second run changes nothing, not even the file's bytes.
    const bytes = readFileSync(x.file, "utf8");
    assert.equal(x.store.migrateProject(), false);
    assert.equal(readFileSync(x.file, "utf8"), bytes);
  });
}

test("migrating against global values that differ keeps the effective values: an unset model becomes the project's own 'none'", () => {
  const x = legacy(NEXUS_SHAPE);
  const before = meant(x.text);
  writeGlobalSettings(globalWith((g) => { g.runtimes.claude.model = "opus"; g.defaults.review_level = 1; g.defaults.context_reuse_threshold = 0.7; }));
  assert.equal(x.store.migrateProject(), true);
  const s = x.stored();
  assert.equal(s.runtimes.claude.model, null, "it had none; the global one would change it");
  assert.equal(s.defaults.review_level, 2);
  assert.equal(s.defaults.context_reuse_threshold, undefined, "now equal to the global value: follows");
  assert.deepEqual(x.store.readProject(), before);
  assert.equal(x.store.migrateProject(), false);
  assert.deepEqual(readGlobalSettings().runtimes.claude.model, "opus");
});

test("own makes a setting the project's own even with the global value; follow and own together are refused", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  updateSettings(store, { defaults: { review_level: 2 }, own: ["defaults.review_level"] });
  assert.equal(store.readStoredProject().defaults.review_level, 2, "its own, though equal to the global value");
  writeGlobalSettings(globalWith((g) => { g.defaults.review_level = 1; }));
  assert.equal(store.readProject().defaults.review_level, 2, "so a global change does not move it");
  assert.throws(() => updateSettings(store, { own: ["defaults.context_care"], follow: ["defaults.context_care"] }), /either follows the global value or is the project's own/);
  // The orchestrator's model and effort through the same action; its section is made if the project has none.
  updateSettings(store, { orchestrator: { model: "opus", effort: null }, own: ["orchestrator.model", "orchestrator.effort"] });
  assert.deepEqual([store.readStoredProject().orchestrator?.model, store.readStoredProject().orchestrator?.effort], ["opus", null]);
  assert.equal(store.readStoredProject().orchestrator?.notify, undefined, "its notices follow");
});

test("a change of the global settings: values replaced, null clears an optional one, an invalid one is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  updateGlobalSettings({ runtimes: { claude: { model: "opus", effort: "high" } }, defaults: { usage_pause_threshold: 0.8 } });
  assert.deepEqual([store.readProject().runtimes.claude.model, store.readProject().defaults.usage_pause_threshold], ["opus", 0.8], "a following project has them at once");
  updateGlobalSettings({ runtimes: { claude: { model: null } } });
  assert.deepEqual([readGlobalSettings().runtimes.claude.model, readGlobalSettings().runtimes.claude.effort], [undefined, "high"]);
  assert.throws(() => updateGlobalSettings({ runtimes: { claude: { effort: "ultra" } } }), (e: Error) => e instanceof ActionError && /runtimes\.claude\.effort/.test(e.message));
  assert.equal(readGlobalSettings().runtimes.claude.effort, "high", "nothing written");
  assert.deepEqual(ownKeys(store.readStoredProject()), []);
});

test("the orchestrator's context threshold: 0.85 by default, global with a project override; a section written without it keeps it", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  assert.equal(builtInSettings().orchestrator.context_threshold, 0.85);
  // The orchestrator's section made from a literal that leaves the setting out (as the server makes it): it follows.
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null, ...p.orchestrator } }));
  assert.equal(store.readStoredProject().orchestrator?.context_threshold, undefined);
  assert.equal(store.readProject().orchestrator?.context_threshold, 0.85);
  writeGlobalSettings(globalWith((x) => { x.orchestrator.context_threshold = 0.8; }));
  assert.equal(store.readProject().orchestrator?.context_threshold, 0.8);
  updateSettings(store, { orchestrator: { context_threshold: 0.9 } });
  assert.deepEqual([store.readStoredProject().orchestrator?.context_threshold, store.readProject().orchestrator?.context_threshold], [0.9, 0.9]);
  assert.ok(ownKeys(store.readStoredProject()).includes("orchestrator.context_threshold"));
  // Left out of a later write of the section, the project's own value stays.
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: "s1" } }));
  assert.equal(store.readProject().orchestrator?.context_threshold, 0.9);
  assert.throws(() => updateSettings(store, { orchestrator: { context_threshold: 1.5 } }));
  updateSettings(store, { follow: ["orchestrator.context_threshold"] });
  assert.equal(store.readProject().orchestrator?.context_threshold, 0.8);
});

test("the partners' web level: search by default, global with a project override, one of off, search and fetch", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  assert.equal(builtInSettings().conversations.web, "search", "built-in: a web search");
  assert.equal(store.readProject().conversations.web, "search");
  assert.equal(store.readStoredProject().conversations.web, undefined, "a new project follows the global value");
  writeGlobalSettings(globalWith((x) => { x.conversations.web = "off"; }));
  assert.equal(store.readProject().conversations.web, "off");
  updateSettings(store, { conversations: { web: "fetch" } });
  assert.deepEqual([store.readStoredProject().conversations.web, store.readProject().conversations.web], ["fetch", "fetch"]);
  assert.ok(ownKeys(store.readStoredProject()).includes("conversations.web"));
  assert.throws(() => updateSettings(store, { conversations: { web: "everything" } }));
  updateSettings(store, { follow: ["conversations.web"] });
  assert.equal(store.readProject().conversations.web, "off");
});

test("the stop conditions and the send-back limit (the settings panel, queue MX): saved globally, overridden by a project, restored by following again", () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-settings-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  const effective = () => store.readProject().defaults;
  const own = () => ownKeys(store.readStoredProject()).filter((k) => /stop_conditions|send_back/.test(k));
  assert.deepEqual([effective().stop_conditions, effective().review_send_back_limit], [[], 2], "built in: none, 2");

  // Saved on the global page: every following project has them at once.
  updateGlobalSettings({ defaults: { stop_conditions: ["Never touch the production database."], review_send_back_limit: 3 } });
  assert.deepEqual([readGlobalSettings().defaults.stop_conditions, readGlobalSettings().defaults.review_send_back_limit], [["Never touch the production database."], 3]);
  assert.deepEqual([effective().stop_conditions, effective().review_send_back_limit], [["Never touch the production database."], 3]);
  assert.deepEqual(own(), []);

  // The project's own: a list that replaces the global one whole, and a limit of 0.
  const mine = ["Stop before a schema change.", "Stop if a step needs a new dependency."];
  updateSettings(store, { defaults: { stop_conditions: mine, review_send_back_limit: 0 }, own: ["defaults.stop_conditions", "defaults.review_send_back_limit"] });
  assert.deepEqual([store.readStoredProject().defaults.stop_conditions, store.readStoredProject().defaults.review_send_back_limit], [mine, 0]);
  assert.deepEqual(own(), ["defaults.stop_conditions", "defaults.review_send_back_limit"]);
  updateGlobalSettings({ defaults: { stop_conditions: ["Something else."], review_send_back_limit: 5 } });
  assert.deepEqual([effective().stop_conditions, effective().review_send_back_limit], [mine, 0], "a global change does not move them");
  // Its own empty list is its own too: no conditions beyond each queue's.
  updateSettings(store, { defaults: { stop_conditions: [] }, own: ["defaults.stop_conditions"] });
  assert.deepEqual(effective().stop_conditions, []);

  // Following again: the global values.
  updateSettings(store, { follow: ["defaults.stop_conditions", "defaults.review_send_back_limit"] });
  assert.deepEqual(own(), []);
  assert.deepEqual([effective().stop_conditions, effective().review_send_back_limit], [["Something else."], 5]);

  // Restored globally: an empty list, the built-in limit; a negative or fractional limit is refused, nothing written.
  updateGlobalSettings({ defaults: { stop_conditions: [], review_send_back_limit: 2 } });
  assert.deepEqual([effective().stop_conditions, effective().review_send_back_limit], [[], 2]);
  for (const n of [-1, 1.5]) assert.throws(() => updateGlobalSettings({ defaults: { review_send_back_limit: n } }), (e: Error) => e instanceof ActionError && /review_send_back_limit/.test(e.message));
  assert.throws(() => updateSettings(store, { defaults: { review_send_back_limit: -1 }, own: ["defaults.review_send_back_limit"] }), (e: Error) => e instanceof ActionError && /review_send_back_limit/.test(e.message));
  assert.equal(effective().review_send_back_limit, 2);
});

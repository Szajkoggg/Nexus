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
  ActionError, ProjectFile, ProjectStore, builtInSettings, effectiveProject, readGlobalSettings, updateSettings, writeGlobalSettings,
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

const globalWith = (change: (g: GlobalSettings) => void): GlobalSettings => { const g = builtInSettings(); change(g); return g; };

test("the effective value is the project's own where it has one, else the global one; null is its own 'none'", () => {
  const g = globalWith((x) => { x.defaults.review_policy = "wait"; x.runtimes.claude.model = "opus"; x.runtimes.codex.model = "gpt-6-astra"; x.orchestrator.notify = false; });
  const stored: StoredProject = {
    protocol: 1, id: "p", name: "P", root: "C:/p", follows_global: true,
    defaults: { context_reuse_threshold: 0.7, worktree_dir: "C:/w" },
    runtimes: { claude: { effort: "high", allowed_tools: ["WebFetch"] }, codex: { model: null } },
    conversations: { notes_dir: "notes" },
  };
  const p = effectiveProject(stored, g);
  assert.equal(p.defaults.review_policy, "wait", "follows the global value");
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
  assert.equal(stored().defaults.review_policy, undefined, "a new project follows every global setting");

  updateSettings(store, { defaults: { review_policy: "wait" }, runtimes: { claude: { model: "sonnet" } } });
  assert.deepEqual([stored().defaults.review_policy, stored().runtimes.claude.model], ["wait", "sonnet"]);
  assert.equal(stored().defaults.usage_pause_threshold, undefined, "untouched: still follows");

  // A whole settings form sent back unchanged (as the dashboard does) changes nothing: following stays following.
  updateSettings(store, { defaults: { ...store.readProject().defaults, review_policy: "wait" } });
  assert.equal(stored().defaults.usage_pause_threshold, undefined);
  assert.equal(stored().defaults.review_policy, "wait");

  // The global value changes: a following project follows it at once; one with its own value keeps it.
  writeGlobalSettings(globalWith((x) => { x.defaults.usage_pause_threshold = 0.8; x.defaults.review_policy = "orchestrator"; }));
  assert.equal(store.readProject().defaults.usage_pause_threshold, 0.8);
  assert.equal(store.readProject().defaults.review_policy, "wait");

  // Clearing an optional setting is its own "none", not following.
  updateSettings(store, { runtimes: { claude: { model: null } } });
  assert.equal(stored().runtimes.claude.model, null);
  assert.equal(store.readProject().runtimes.claude.model, undefined);

  // Switching the overrides off: they follow the global value again.
  updateSettings(store, { follow: ["defaults.review_policy", "runtimes.claude.model"] });
  assert.deepEqual([stored().defaults.review_policy, stored().runtimes.claude.model], [undefined, undefined]);
  assert.equal(store.readProject().defaults.review_policy, "orchestrator");
  assert.throws(() => updateSettings(store, { follow: ["conversations.notes_dir"] }), (e: Error) => e instanceof ActionError && /not a setting with a global value: conversations.notes_dir/.test(e.message));

  // The orchestrator's section made later (its session) follows the global settings too.
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: "s1" } }));
  assert.deepEqual(stored().orchestrator, { session: "s1" });
});

for (const [name, shape] of [["Nexus", NEXUS_SHAPE], ["Project Honeycomb", HONEYCOMB_SHAPE]] as const) {
  test(`migrating ${name}'s project.yaml: equal values follow, different ones become its own, effective values unchanged, once`, () => {
    const x = legacy(shape);
    const before = ProjectFile.parse(YAML.parse(x.text)); // what the file meant before global settings
    assert.deepEqual(x.store.readProject(), before, "an unmigrated file reads as before");
    assert.equal(x.store.migrateProject(), true);
    const s = x.stored();
    assert.equal(s.follows_global, true);
    // Equal to the built-in global values: following.
    assert.equal(s.defaults.review_policy, undefined);
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
  const before = ProjectFile.parse(YAML.parse(x.text));
  writeGlobalSettings(globalWith((g) => { g.runtimes.claude.model = "opus"; g.defaults.review_policy = "wait"; g.defaults.context_reuse_threshold = 0.7; }));
  assert.equal(x.store.migrateProject(), true);
  const s = x.stored();
  assert.equal(s.runtimes.claude.model, null, "it had none; the global one would change it");
  assert.equal(s.defaults.review_policy, "continue");
  assert.equal(s.defaults.context_reuse_threshold, undefined, "now equal to the global value: follows");
  assert.deepEqual(x.store.readProject(), before);
  assert.equal(x.store.migrateProject(), false);
  assert.deepEqual(readGlobalSettings().runtimes.claude.model, "opus");
});

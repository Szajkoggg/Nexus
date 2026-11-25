// A file that is there but cannot be read is not a missing file (docs/design/state.md, "Missing and unreadable
// files"): a reader gives its default only for a missing file; an unreadable one is an error naming the file, or, where
// the server goes on with a default, a warning with its path, and the writer sets it aside as <file>.corrupt before
// it writes a new one. Nothing overwrites an unreadable file.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, applyDraft, approveQueue, ensureUserSession, loadProjectState, newId, now, readAway, readUsage, writeAway, USER_SESSION,
} from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-unreadable-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  return { root, store };
}
const draft = (title: string) => ({ protocol: 1, id: "Q", title, steps: [{ id: "Q1", title: "One", goal: "Do one.", acceptance: ["one works"] }] });
/** console.warn's lines while `fn` runs. */
function warned(fn: () => void): string[] {
  const lines: string[] = [];
  const m = mock.method(console, "warn", (...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  try { fn(); } finally { m.mock.restore(); }
  return lines;
}

test("a draft beside an unreadable queue.yaml is refused with the file's name; the file and its approvals stay", () => {
  const { store } = setup();
  applyDraft(store, draft("First"));
  approveQueue(store, "Q");
  const file = join(store.queueDir("Q"), "queue.yaml");
  assert.match(readFileSync(file, "utf8"), /approvals:/);
  // A newer schema's file (after an update was rolled back) or a damaged one: either way not a queue this server reads.
  writeFileSync(file, `${readFileSync(file, "utf8")}\nsteps: [unclosed\n`);
  const before = readFileSync(file, "utf8");
  assert.throws(() => applyDraft(store, draft("Second")), (e: Error) => e.message.includes("queue.yaml"), "the error names the file");
  assert.equal(readFileSync(file, "utf8"), before, "the file, approvals and history included, is untouched");
});

test("the dashboard's session is not made again over an unreadable session.yaml", () => {
  const { store } = setup();
  ensureUserSession(store);
  const file = join(store.sessionDir(USER_SESSION), "session.yaml");
  writeFileSync(file, "role: [unclosed\n");
  assert.throws(() => ensureUserSession(store), (e: Error) => e.message.includes("session.yaml"));
  assert.equal(readFileSync(file, "utf8"), "role: [unclosed\n");
});

test("an unreadable runtime.json is a warning in the project's state; its writer sets it aside before writing anew", () => {
  const { store } = setup();
  const s = { protocol: 1 as const, id: newId(), project: "p", role: "conversation" as const, runtime: "claude" as const, title: "S", native_id: null, cwd: store.dir, launched_by: "nexus" as const, created_at: now() };
  store.writeSession(s);
  const file = join(store.sessionDir(s.id), "runtime.json");
  writeFileSync(file, "{ half");
  assert.equal(store.readRuntime(s.id, () => {}), undefined, "the session goes on without a record");
  const state = loadProjectState(store);
  assert.ok(state.warnings.some((w) => w.includes("runtime.json")), `a warning with the path: ${state.warnings.join(" | ")}`);
  const lines = warned(() => store.writeRuntime(s.id, { state: "idle", turns: 0, updated_at: now() }));
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ half", "set aside");
  assert.ok(lines.some((l) => l.includes("runtime.json") && l.includes(".corrupt")), `told: ${lines.join(" | ")}`);
  assert.equal(store.readRuntime(s.id)?.state, "idle", "the new record is written");
  assert.ok(!loadProjectState(store).warnings.some((w) => w.includes("runtime.json")), "and the warning is gone");
});

test("a missing file is the default, without a warning", () => {
  const { store } = setup();
  const lines = warned(() => {
    assert.deepEqual(store.readPins("none"), { pins: [] });
    assert.equal(store.readRuntime("none"), undefined);
    assert.equal(readUsage(), undefined);
    assert.equal(readAway().protocol, 1);
    store.observeClock();
  });
  assert.deepEqual(lines, []);
});

test("unreadable account-wide files warn with their path and are set aside before they are written again", () => {
  setup();
  const home = process.env.NEXUS_HOME!;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "usage.json"), "not json");
  writeFileSync(join(home, "away.yaml"), "until: [unclosed");
  const lines = warned(() => { assert.equal(readUsage(), undefined); assert.equal(readAway().current, undefined); });
  assert.ok(lines.some((l) => l.includes("usage.json")) && lines.some((l) => l.includes("away.yaml")), lines.join(" | "));
  assert.ok(existsSync(join(home, "usage.json")), "a reader does not move the file");
});

test("an unreadable away.yaml is a warning in the project's state, and set aside as away.yaml.corrupt at the next write (survey LC3, F15)", () => {
  const { store } = setup();
  const home = process.env.NEXUS_HOME!;
  mkdirSync(home, { recursive: true });
  const file = join(home, "away.yaml");
  const broken = "current: [unclosed";
  writeFileSync(file, broken);
  const state = loadProjectState(store);
  assert.ok(state.warnings.some((w) => w.includes("away.yaml cannot be read")), `a warning with the path: ${state.warnings.join(" | ")}`);
  assert.equal(state.away.on, false, "away mode off: the default");
  const lines = warned(() => writeAway({ protocol: 1, past: [] }));
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), broken, "set aside as it was");
  assert.ok(lines.some((l) => l.includes("away.yaml") && l.includes(".corrupt")), `told: ${lines.join(" | ")}`);
  assert.ok(!loadProjectState(store).warnings.some((w) => w.includes("away.yaml")), "and the warning is gone");
});

test("a project.yaml its schema refuses: the project's state fails with the file's name and the issue as path: message", () => {
  const { store } = setup();
  writeFileSync(store.projectFile, `${readFileSync(store.projectFile, "utf8")}\nname: 42\n`.replace(/^name: .*\n/m, ""));
  assert.throws(() => loadProjectState(store), (e: Error) => {
    assert.match(e.message, /\/project\.yaml cannot be read: name: /, e.message);
    assert.doesNotMatch(e.message, /"code"/, "zod's raw JSON is not the text");
    return true;
  });
});

test("a run.yaml its schema refuses is a warning naming the file once", () => {
  const { store } = setup();
  applyDraft(store, draft("First"));
  writeFileSync(join(store.queueDir("Q"), "run.yaml"), "state: 7\n");
  const warnings = loadProjectState(store).warnings.filter((w) => w.includes("run.yaml"));
  assert.equal(warnings.length, 1, warnings.join(" | "));
  assert.match(warnings[0]!, /queues\/Q\/run\.yaml cannot be read: \w+: /);
  assert.doesNotMatch(warnings[0]!, /^queue Q run:/);
});

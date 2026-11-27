// A file that is there but cannot be read is not a missing file (docs/design/state.md, "Missing and unreadable
// files"): a reader gives its default only for a missing file; an unreadable one is an error naming the file, or, where
// the server goes on with a default, a warning with its path, and the writer sets it aside as <file>.corrupt before
// it writes a new one. Nothing overwrites an unreadable file.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/errors.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, ProjectStore, addNote, applyDraft, approveQueue, ensureUserSession, loadProjectState, newId, now, queueView, readAway, readUsage, refuseUnreadable, sendMessage, sessionView, setAsideCorrupt, writeAway, USER_SESSION,
} from "../src/index.ts";
import { faultRenames } from "../src/store.ts";

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

// ---------------------------------------------------------------- queue LCK (survey LC3, F12 and F14)

/** The ActionError an action threw: its status and message. */
function refusal(fn: () => unknown): { status: number; message: string } {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ActionError, `an ActionError, not: ${errorText(e)}`);
    return { status: e.status, message: e.message };
  }
  assert.fail("not refused");
}

test("F12: actions on an unreadable queue.yaml are refused (409) with the file's name, never as an unknown queue or a server failure", () => {
  const { store } = setup();
  applyDraft(store, draft("First"));
  approveQueue(store, "Q");
  const file = join(store.queueDir("Q"), "queue.yaml");
  writeFileSync(file, "steps: [unclosed\n");
  for (const [what, fn] of [
    ["applyDraft", () => applyDraft(store, draft("Second"))],
    ["approveQueue", () => approveQueue(store, "Q")],
    ["addNote", () => addNote(store, "Q", "Q1", "a note")],
    ["queueView", () => queueView(loadProjectState(store), "Q")],
  ] as const) {
    const r = refusal(fn);
    assert.equal(r.status, 409, `${what}: ${r.message}`);
    assert.match(r.message, /queues\/Q\/queue\.yaml cannot be read/, what);
  }
  assert.equal(readFileSync(file, "utf8"), "steps: [unclosed\n", "the file is untouched");
  assert.equal(refusal(() => approveQueue(store, "X")).status, 404, "a queue that is not there is still unknown");
});

test("F12: a message to a session whose session.yaml cannot be read is refused (409) with the file's name", () => {
  const { store } = setup();
  const s = { protocol: 1 as const, id: newId(), project: "p", role: "conversation" as const, runtime: "claude" as const, title: "S", native_id: null, cwd: store.dir, launched_by: "nexus" as const, created_at: now() };
  store.writeSession(s);
  writeFileSync(join(store.sessionDir(s.id), "session.yaml"), "role: [unclosed\n");
  const r = refusal(() => sendMessage(store, s.id, "hello"));
  assert.equal(r.status, 409, r.message);
  assert.match(r.message, /session\.yaml cannot be read/);
  const v = refusal(() => sessionView(loadProjectState(store), s.id));
  assert.equal(v.status, 409, v.message);
  assert.match(v.message, /session\.yaml cannot be read/);
  assert.equal(refusal(() => sessionView(loadProjectState(store), "none")).status, 404);
  const other = new Error("other");
  assert.equal(refuseUnreadable(other), other, "any other error goes through as it is (the API's 500)");
});

/** A conversation session with an unreadable runtime.json that a reader with a default has met; its path. */
function metUnreadableRuntime(store: ProjectStore, text: string): { id: string; file: string } {
  const s = { protocol: 1 as const, id: newId(), project: "p", role: "conversation" as const, runtime: "claude" as const, title: "S", native_id: null, cwd: store.dir, launched_by: "nexus" as const, created_at: now() };
  store.writeSession(s);
  const file = join(store.sessionDir(s.id), "runtime.json");
  writeFileSync(file, text);
  assert.equal(store.readRuntime(s.id, () => {}), undefined);
  return { id: s.id, file };
}

test("F14: a write that fails after the unreadable file was set aside puts it back; the next write sets it aside again", () => {
  const { store } = setup();
  const { id, file } = metUnreadableRuntime(store, "{ half");
  const fault = ProjectStore.faultWrites({ file: `sessions/${id}/runtime.json` });
  let lines: string[] = [];
  try {
    lines = warned(() => assert.throws(() => store.writeRuntime(id, { state: "idle", turns: 0, updated_at: now() }), /injected write fault/));
  } finally { fault.clear(); }
  assert.equal(readFileSync(file, "utf8"), "{ half", "the unreadable file is back in its place");
  assert.ok(!existsSync(`${file}.corrupt`), "and not left aside");
  assert.ok(lines.some((l) => l.includes("runtime.json") && l.includes("back in its place")), `told: ${lines.join(" | ")}`);
  assert.ok(loadProjectState(store).warnings.some((w) => w.includes("runtime.json")), "a read still warns of it");
  warned(() => store.writeRuntime(id, { state: "idle", turns: 0, updated_at: now() }));
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ half", "set aside at the next write");
  assert.equal(store.readRuntime(id)?.state, "idle");
});

// Survey LC4 finding 9 (queue LCG): the put-back itself fails. The file is missing then, and the warning says where its
// unreadable content is; the next read finds no file (the default), and the copy aside is never written over.
test("F14: a write that fails after the unreadable file was set aside, and whose put-back fails too, says it is missing and where its content is", () => {
  const { store } = setup();
  const { id, file } = metUnreadableRuntime(store, "{ half");
  const writes = ProjectStore.faultWrites({ file: `sessions/${id}/runtime.json` });
  const renames = faultRenames({ file: `sessions/${id}/runtime.json`, code: "EIO" }); // not passing: thrown at once
  let lines: string[] = [];
  try {
    lines = warned(() => assert.throws(() => store.writeRuntime(id, { state: "idle", turns: 0, updated_at: now() }), /injected write fault/));
  } finally { writes.clear(); renames.clear(); }
  assert.equal(renames.failed(), 1, "the put-back's rename was refused");
  assert.ok(!existsSync(file), "the file is missing now");
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ half", "its unreadable content is aside");
  assert.ok(lines.some((l) => l.includes("runtime.json") && l.includes("nor put back") && l.includes("runtime.json.corrupt")), `told: ${lines.join(" | ")}`);
  assert.equal(store.readRuntime(id), undefined, "a read finds no file: the default");
  warned(() => store.writeRuntime(id, { state: "idle", turns: 0, updated_at: now() }));
  assert.equal(store.readRuntime(id)?.state, "idle", "the next write goes in");
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ half", "the copy aside is kept");
});

test("F14: a second damage is set aside as <file>.corrupt.2, the first one's copy kept", () => {
  const { store } = setup();
  const { id, file } = metUnreadableRuntime(store, "{ first");
  warned(() => store.writeRuntime(id, { state: "idle", turns: 0, updated_at: now() }));
  writeFileSync(file, "{ second");
  assert.equal(store.readRuntime(id, () => {}), undefined);
  const lines = warned(() => store.writeRuntime(id, { state: "idle", turns: 1, updated_at: now() }));
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ first", "the first damage is kept");
  assert.equal(readFileSync(`${file}.corrupt.2`, "utf8"), "{ second", "the second goes beside it");
  assert.ok(lines.some((l) => l.includes("runtime.json.corrupt.2")), `told by its name: ${lines.join(" | ")}`);
  writeFileSync(file, "{ third");
  assert.equal(setAsideCorrupt(file), `${file}.corrupt.3`, "and a third after it");
});

// The CLI's role checks for check --unrelated and queue draft --template, its usage errors for a command line it cannot
// take (a negative value, a role, runtime or note sender the protocol does not know), and nexus --help (queue ACF).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, newId, type Event, type Role } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

/** A project whose step Q1 is in a check-fix round: Nexus's checks failed on npm test, the worker started it again. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-roles-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = new Date().toISOString();
  const roles: Record<string, Role> = { w: "worker", o: "orchestrator", c: "conversation" };
  for (const [id, role] of Object.entries(roles)) store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, ...(role === "worker" ? { queue: "Q" } : {}) });
  store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"], steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  approveQueue(store, "Q");
  const T0 = Date.now() - 60_000;
  const emit = (s: number, body: Record<string, unknown>) => { const e = { v: 1, id: newId(), at: new Date(T0 + s * 1000).toISOString(), session: "w", ...body } as Event; store.appendEvent(e); return e; };
  emit(1, { type: "step.started", queue: "Q", step: "Q1" });
  const done = emit(2, { type: "step.done", queue: "Q", step: "Q1", summary: "done" });
  const run = { started_at: done.at, ended_at: done.at, exit_code: 1, duration: 1, log: "checks/Q1/x.log", failed_tests: ["a"] };
  store.writeChecks("Q", { protocol: 1, steps: { Q1: { by: "nexus", sets: [{ done: done.id, round: 1, fix: 0, requested_at: done.at, state: "failed", checks: [{ name: "npm test", command: "npm test", ok: false, runs: [run] }] }] } } });
  emit(5, { type: "step.started", queue: "Q", step: "Q1" });
  const nexus = (session: string, ...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8", env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session, NEXUS_HOME: join(root, "home") } });
  const disputes = () => ["w", "o", "c"].flatMap((s) => store.readEvents(s).entries.filter((e) => e.type === "check.disputed"));
  return { store, nexus, disputes };
}

/** A usage error: exit code 2, one "nexus: ..." line on stderr matching `what`, no stack trace. */
function refused(r: ReturnType<typeof spawnSync>, what: RegExp): void {
  const err = String(r.stderr);
  assert.equal(r.status, 2, err);
  assert.match(err, /^nexus: /);
  assert.match(err, what);
  assert.doesNotMatch(err, /\n\s+at |Error:|node:internal/, "no stack trace");
}

test("check --unrelated is refused an orchestrator and a thinking partner, and taken from the worker", () => {
  const x = setup();
  for (const s of ["o", "c"]) refused(x.nexus(s, "check", "Q1", "npm test", "--unrelated", "--evidence", "fails on main", "--queue", "Q"), /only a worker disputes a failed check/);
  assert.equal(x.disputes().length, 0, "nothing recorded for the refused ones");
  const ok = x.nexus("w", "check", "Q1", "npm test", "--unrelated", "--evidence", "fails on main");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ok: check\.disputed Q\/Q1/);
  assert.equal(x.disputes().length, 1);
  assert.equal(loadProjectState(x.store).queues[0]!.steps[0]!.checking?.phase, "base");
});

test("queue draft --template is refused a worker and a thinking partner, as the file form is", () => {
  const x = setup();
  for (const s of ["w", "c"]) refused(x.nexus(s, "queue", "draft", "--template", "spike", "--set", "question=Why?", "--id", "SP"), /only an orchestrator session may do this/);
  assert.equal(existsSync(join(x.store.dir, "drafts", "SP.yaml")), false, "no draft written");
  const ok = x.nexus("o", "queue", "draft", "--template", "spike", "--set", "question=Why?", "--id", "SP");
  assert.equal(ok.status, 0, ok.stderr);
});

test("a negative value without -- or =, and an option without its value, end as usage errors saying how", () => {
  const x = setup();
  refused(x.nexus("w", "metric", "record", "delta", "-5"), /-5 reads as an option: a negative value goes after -- \(nexus metric record delta -- -5\), or an option's as --option=-5/);
  refused(x.nexus("o", "metric", "define", "delta", "--unit", "KB", "--warn-below", "-5"), /--warn-below has no value, or one starting with -: a negative value goes as --warn-below=-5/);
  refused(x.nexus("w", "status", "--bogus"), /unknown option --bogus \(nexus --help\)/);
  refused(x.nexus("w", "step", "progress", "Q1", "x", "--pct"), /--pct/);
});

test("a role, runtime or note sender the protocol does not know is a usage error, and nothing is written", () => {
  const x = setup();
  const sessions = () => x.store.sessionIds().length;
  const before = sessions();
  refused(x.nexus("w", "attach", "--role", "boss"), /--role is one of worker, orchestrator, .*not "boss"/);
  refused(x.nexus("w", "attach", "--runtime", "gpt"), /--runtime is one of claude, codex, external, not "gpt"/);
  assert.equal(sessions(), before, "no session written");
  refused(x.nexus("w", "note", "Q", "Q1", "hello", "--from", "boss"), /--from is one of user, orchestrator, not "boss"/);
  assert.equal(x.store.readNotes("Q").notes.length, 0, "no note written");
});

test("nexus --help prints what nexus help prints, the topics with it", () => {
  const x = setup();
  const help = x.nexus("w", "help").stdout;
  assert.match(help, /Topics \(nexus help <topic>\):/);
  for (const a of [["--help"], ["-h"], [], ["status", "--help"]]) {
    const r = x.nexus("w", ...a);
    assert.equal(r.status, 0, a.join(" "));
    assert.equal(r.stdout, help, a.join(" ") || "(no command)");
  }
  assert.match(help, /--template <id>.*\n.*\(orchestrator only\) write a draft from a template/);
  assert.match(help, /--unrelated --evidence <text> {3}\(worker only\)/);
});

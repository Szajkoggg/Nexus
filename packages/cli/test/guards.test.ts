// The CLI's guards against silent loss (queue ACX, ACX4): a call that would say ok and change nothing, or record what
// was not meant, is refused with exit code 2 and a message naming what is wrong, never a stack trace; the right call
// next to each still goes through. W2 withdraw, W4 check names, S7 --session, H3 attach --role, H4 missing files and
// unknown queues, H2 an empty standard input, H6 surplus positional arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, loadProjectState, newId, type Event, type Role } from "@nexus/protocol";
import { cliRun, type CliResult } from "./run-cli.ts";

/** A project with an approved queue Q (step Q1 started, checks "npm test" and "npm run lint"), a worker w of it, a
 * second worker v, an orchestrator o, and a worker w2 that took over from w (context care). */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-guards-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = new Date().toISOString();
  const sessions: [string, Role, Record<string, unknown>][] = [["w", "worker", { queue: "Q" }], ["v", "worker", { queue: "Q" }], ["o", "orchestrator", {}], ["w2", "worker", { queue: "Q", continues: "w" }]];
  for (const [id, role, extra] of sessions) store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, ...extra });
  store.writeQueue({ protocol: 1, id: "Q", title: "Q", revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test", "npm run lint"], steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  approveQueue(store, "Q");
  store.appendEvent({ v: 1, id: newId(), at, session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  const env = (session?: string) => {
    const e: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_HOME: join(root, "home") };
    if (session) e.NEXUS_SESSION = session; else delete e.NEXUS_SESSION;
    return e;
  };
  const nexus = (session: string | undefined, args: string[], input?: string) => cliRun(args, { cwd: root, env: env(session), input });
  const events = (s: string, type: string) => store.readEvents(s).entries.filter((e) => e.type === type);
  return { root, store, nexus, events };
}

/** A usage error: exit code 2, one "nexus: ..." line matching `what`, no stack trace. */
function refused(r: CliResult, what: RegExp): void {
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^nexus: /);
  assert.match(r.stderr, what);
  assert.doesNotMatch(r.stderr, /\n\s+at |Error:|node:internal/, "no stack trace");
}
function ok(r: CliResult): string {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("W2: nexus withdraw refuses an unknown, a closed and another session's question; withdraws an open one of its own or its predecessor's", async () => {
  const x = setup();
  const qid = (out: string) => /question (\S+) sent/.exec(out)![1]!;
  const mine = qid(ok(await x.nexus("w", ["ask", "Which page?", "--step", "Q1"])));
  const theirs = qid(ok(await x.nexus("v", ["ask", "Which colour?", "--step", "Q1"])));
  refused(await x.nexus("w", ["withdraw", "01NOSUCHQUESTION", "--reason", "typo"]), /no question 01NOSUCHQUESTION in this project/);
  refused(await x.nexus("w", ["withdraw", theirs, "--reason", "not mine"]), new RegExp(`question ${theirs} is another session's \\(v\\); a session withdraws only its own questions`));
  assert.equal(x.events("w", "question.withdrawn").length, 0, "nothing recorded");
  ok(await x.nexus("w", ["withdraw", mine, "--reason", "settled"]));
  refused(await x.nexus("w", ["withdraw", mine, "--reason", "again"]), new RegExp(`question ${mine} is withdrawn already: nothing to withdraw`));
  // The session that took over from w (context care) withdraws w's open question.
  const older = qid(ok(await x.nexus("w", ["ask", "Which font?", "--step", "Q1"])));
  ok(await x.nexus("w2", ["withdraw", older, "--reason", "settled in the fresh session"]));
  assert.equal(loadProjectState(x.store).questions.find((q) => q.qid === older)?.state, "withdrawn");
  // An answered question.
  const answered = qid(ok(await x.nexus("w", ["ask", "Which size?", "--step", "Q1"])));
  ok(await x.nexus("o", ["answer", answered, "Large."]));
  refused(await x.nexus("w", ["withdraw", answered, "--reason", "late"]), /is answered already: nothing to withdraw/);
});

test("W4: nexus check refuses a name that is not one of the step's checks, listing them; the listed names are taken", async () => {
  const x = setup();
  refused(await x.nexus("w", ["check", "Q1", "test", "--ok"]), /"test" is not one of step Q1's checks; report each under its name exactly as listed: "npm test", "npm run lint"/);
  assert.equal(x.events("w", "check.result").length, 0, "nothing recorded");
  ok(await x.nexus("w", ["check", "Q1", "npm test", "--ok", "--duration", "3"]));
  ok(await x.nexus("w", ["check", "Q1", "npm run lint", "--fail"]));
  // The project's checks as the run fixed them come first, then the queue's own.
  const at = new Date().toISOString();
  x.store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "Q1", started_at: at, updated_at: at, checks: ["npm run typecheck"] });
  ok(await x.nexus("w", ["check", "Q1", "npm run typecheck", "--ok"]));
  // A step with no checks at all.
  x.store.writeQueue({ ...x.store.readQueue("Q"), checks: [] });
  x.store.writeRun("Q", { protocol: 1, session: "w", state: "running", step: "Q1", started_at: at, updated_at: at, checks: [] });
  refused(await x.nexus("w", ["check", "Q1", "npm test", "--ok"]), /step Q1 has no checks to report/);
  assert.equal(x.events("w", "check.result").length, 3);
});

test("S7: a --session other than the set NEXUS_SESSION is refused; the same one, or --session without NEXUS_SESSION, is taken", async () => {
  const x = setup();
  refused(await x.nexus("w", ["step", "progress", "Q1", "half", "--session", "o"]), /--session o is not this session \(NEXUS_SESSION is w\): a session writes only its own log; leave --session out/);
  refused(await x.nexus("w", ["review", "accept", "Q", "Q1", "--session", "o"]), /--session o is not this session/);
  refused(await x.nexus("w", ["status", "--session", "o"]), /--session o is not this session/);
  assert.equal(x.events("o", "review.accepted").length, 0, "nothing in the orchestrator's log");
  ok(await x.nexus("w", ["step", "progress", "Q1", "half", "--session", "w"]));
  ok(await x.nexus(undefined, ["step", "progress", "Q1", "more", "--session", "w"]));
  assert.equal(x.events("w", "step.progress").length, 2);
});

test("H3: nexus attach --role takes worker or orchestrator only; H4: an unknown --queue is a usage error", async () => {
  const x = setup();
  const before = x.store.sessionIds().length;
  for (const role of ["user", "nexus", "helper", "conversation"]) {
    refused(await x.nexus(undefined, ["attach", "--role", role]), new RegExp(`--role is one of worker, orchestrator, not "${role}"`));
  }
  refused(await x.nexus(undefined, ["attach", "--queue", "NOPE"]), /unknown queue NOPE \(nexus status lists the queues\)/);
  assert.equal(x.store.sessionIds().length, before, "no session written");
  ok(await x.nexus(undefined, ["attach", "--role", "orchestrator"]));
  ok(await x.nexus(undefined, ["attach", "--queue", "Q"]));
  assert.equal(x.store.sessionIds().length, before + 2);
});

test("H4: a file that is not there (queue draft, import) is a usage error naming it", async () => {
  const x = setup();
  refused(await x.nexus("o", ["queue", "draft", "missing.yaml"]), /no such file: .*missing\.yaml/);
  refused(await x.nexus(undefined, ["import", "missing.md"]), /no such file: .*missing\.md/);
  writeFileSync(join(x.root, "q.md"), "# Nothing here\n");
  ok(await x.nexus(undefined, ["import", "q.md", "--dry-run"]));
});

test("H2: - with an empty standard input records nothing (ask, answer, note, context); with text it is read", async () => {
  const x = setup();
  const empty = /- reads the text from standard input, and it was empty/;
  refused(await x.nexus("w", ["ask", "-", "--step", "Q1"], ""), empty);
  refused(await x.nexus("w", ["context", "-"], "  \n"), empty);
  refused(await x.nexus(undefined, ["note", "Q", "Q1", "-"], ""), empty);
  const qid = /question (\S+) sent/.exec(ok(await x.nexus("w", ["ask", "-", "--step", "Q1"], "Which page first?")))![1]!;
  refused(await x.nexus("o", ["answer", qid, "-"], ""), empty);
  assert.equal(x.events("o", "answer.given").length, 0);
  assert.equal(x.store.readNotes("Q").notes.length, 0);
  ok(await x.nexus("o", ["answer", qid, "-"], "The second."));
  ok(await x.nexus("w", ["context", "-"], "Where it stands."));
  ok(await x.nexus(undefined, ["note", "Q", "Q1", "-"], "Mind the margins."));
  assert.equal(x.store.readNotes("Q").notes.length, 1);
  assert.equal(x.events("w", "question.asked").length, 1);
});

test("H6: surplus positional arguments are refused (an unquoted text, a glob of files); the quoted forms are taken", async () => {
  const x = setup();
  const surplus = /takes no more arguments, not .*: quote a text with spaces as one argument, and give a list comma-separated/;
  refused(await x.nexus("w", ["context", "Summary", "--files", "src/a.ts", "src/b.ts"]), /nexus context <text\|-> takes no more arguments, not "src\/b\.ts"/);
  for (const args of [
    ["ask", "Which", "page?"], ["withdraw", "q1", "extra", "--reason", "x"], ["log", "two", "words"],
    ["step", "progress", "Q1", "half", "way"], ["step", "start", "Q1", "Q2"], ["step", "failed", "Q1", "x", "--reason", "r"],
    ["step", "done", "Q1", "extra", "--summary", "s"], ["stop", "Q1", "x", "--condition", "c", "--reason", "r"],
    ["check", "Q1", "npm", "test", "--ok"],
  ]) refused(await x.nexus("w", args), surplus);
  refused(await x.nexus("o", ["answer", "q1", "The", "second."]), surplus);
  refused(await x.nexus(undefined, ["note", "Q", "Q1", "Mind", "it"]), surplus);
  assert.equal(x.store.readEvents("w").entries.length, 1, "only the step's start");
  ok(await x.nexus("w", ["context", "Summary", "--files", "src/a.ts,src/b.ts"]));
  ok(await x.nexus("w", ["step", "progress", "Q1", "half way"]));
  ok(await x.nexus("w", ["log", "two words"]));
});

// Queue LKF (survey LC3): a session or queue file that is there but cannot be read is not "unknown": the refusal names
// the file (the store's UnreadableFileError), still a usage error; a missing one stays "unknown …".
test("an unreadable session.yaml or queue.yaml is refused naming the file; a missing one is still unknown", async () => {
  const x = setup();
  const badSession = join(x.store.sessionDir("bad"), "session.yaml");
  mkdirSync(join(badSession, ".."), { recursive: true });
  writeFileSync(badSession, "protocol: [1\nid: bad\n");
  const badQueue = join(x.store.queueDir("BAD"), "queue.yaml");
  mkdirSync(join(badQueue, ".."), { recursive: true });
  writeFileSync(badQueue, "id: BAD\nsteps: 3\n");
  const report = join(x.root, "report.md");
  writeFileSync(report, "# Report\n");
  /** The refusal names the file (forward slashes, as the store writes paths), then why it cannot be read. */
  const unreadable = (r: CliResult, file: string) => {
    refused(r, / cannot be read: /);
    assert.ok(r.stderr.includes(`${file.replaceAll("\\", "/")} cannot be read: `), r.stderr);
  };

  unreadable(await x.nexus("bad", ["step", "progress", "Q1", "half"]), badSession);
  refused(await x.nexus("nosuch", ["step", "progress", "Q1", "half"]), /^nexus: unknown session nosuch\n$/);

  unreadable(await x.nexus("w", ["step", "progress", "Q1", "half", "--queue", "BAD"]), badQueue);
  refused(await x.nexus("w", ["step", "progress", "Q1", "half", "--queue", "NOPE"]), /^nexus: unknown queue NOPE\n$/);

  unreadable(await x.nexus("o", ["report", "BAD", "--file", report, "--summary", "s"]), badQueue);
  refused(await x.nexus("o", ["report", "NOPE", "--file", report, "--summary", "s"]), /^nexus: unknown queue NOPE\n$/);
});

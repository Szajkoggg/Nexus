// The closing refactoring step in the engine (PROTOCOL.md, "The closing refactoring step"), against the fake runtimes:
// it runs after the queue's own steps, also after steps a revision added during the run and after a revision once it
// has run; in a fresh session (a run switch `refactor`), given the queue's commit range from git.yaml and git's --stat,
// and told whether the project's AGENTS.md has a "Refactoring" section. Its "nothing worth refactoring" closes the
// queue, and the queue's report is its to write. The protocol side (the field, the hash, skipping, queue set finished)
// is packages/protocol/test/closing.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, loadProjectState, now, routeAnswers, type StepDef } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { closingContext, hasRefactoringSection } from "../src/closing.ts";
import { acceptReviews } from "./fake-reviewer.ts";
import { LONGER, holdWork, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const step = (id: string, behaviour: string): StepDef => ({ id, title: `Step ${id}`, goal: `FAKE: ${behaviour}`, acceptance: [] });
const G = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

function setup(steps: StepDef[], o: { git?: boolean; rules?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-closing-"));
  // A temporary directory of this test's own (the worker inherits it): the report's folder is in it.
  const temp = join(base, "temp");
  mkdirSync(temp);
  process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
  const root = join(base, "project");
  mkdirSync(root);
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const git = (...a: string[]) => execFileSync("git", [...G, ...a], { cwd: root, encoding: "utf8" }).trim();
  if (o.git) {
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".nexus/\n");
    if (o.rules) writeFileSync(join(root, "AGENTS.md"), "# Rules\n\n## Refactoring\n\nKeep functions short.\n");
    git("add", "-A"); git("commit", "-qm", "init");
  }
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", coding: true, stop_conditions: [], checks: [], steps });
  approveQueue(store, "Q");
  const engines: Engine[] = [];
  const engine = (): Engine => {
    const e: Engine = new Engine(store, () => { routeAnswers(store); acceptReviews(store); e.onChange(loadProjectState(store)); }, { retryBaseMs: 30, usageMarginMs: 100 });
    engines.push(e);
    return e;
  };
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const received = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { text: string; session: string | null });
  /** The step turns as they were opened, in order (a seed before the opening included). */
  const openings = () => received().filter((r) => /(^|\n)\[Nexus\] Queue Q /.test(r.text)).map((r) => ({ ...r, step: /step (\S+) \(\d+ of \d+\)/.exec(r.text)![1]! }));
  const until = (what: string, pred: () => boolean, ms: number = LONGER.run) =>
    waitUntil(what, pred, ms, () => `; run ${JSON.stringify(queue().run)}; ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  const stop = () => { for (const e of engines) e.shutdown(); };
  return { root, store, git, engine, queue, received, openings, until, stop };
}

test("the closing step runs last in a fresh session, with the queue's commit range; nothing to refactor closes the queue, and it writes the report", async () => {
  const x = setup([step("Q1", "commit"), step("Q2", "commit")], { git: true });
  const start = x.git("rev-parse", "HEAD");
  try {
    x.engine().start("Q", { runtime: "claude" });
    await x.until("the run finished", () => x.queue().run?.state === "finished", LONGER.processes);
    const q = x.queue();
    assert.deepEqual(q.steps.map((s) => `${s.id}=${s.status}`), ["Q1=done", "Q2=done", "Q.refactor=done"]);
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q2", "Q.refactor"], "the closing step is opened last");
    assert.equal(q.status, "done", "its finding that nothing is worth refactoring closes the queue");
    const closing = q.steps.at(-1)!;
    assert.match(closing.summary!, /nothing in Q\.refactor is worth refactoring/);

    // A fresh session: the run switched for it, and the closing step's turn came in the new session.
    const sw = q.run!.switches ?? [];
    assert.equal(sw.length, 1);
    assert.equal(sw[0]!.why, "refactor");
    assert.equal(sw[0]!.step, "Q.refactor");
    assert.equal(sw[0]!.from, q.steps[0]!.session);
    assert.equal(sw[0]!.to, closing.session);
    assert.notEqual(closing.session, q.steps[1]!.session);
    const opening = x.openings().at(-1)!;
    assert.equal(opening.session, closing.session);

    // Its text: the seed (no summary of the previous session), the standard goal, the range from git.yaml and --stat.
    const head = x.git("rev-parse", "HEAD");
    assert.notEqual(start, head);
    assert.match(opening.text, /^\[Nexus\] You take over queue Q "Queue" in a fresh session: step Q\.refactor is the queue's closing refactoring step, which reads the queue's work with fresh eyes\./);
    assert.ok(opening.text.includes("Read its work from its commits"), opening.text);
    assert.ok(!opening.text.includes("context summary at the end of"), "no summary of the previous session");
    assert.ok(opening.text.includes("step Q.refactor (3 of 3): Closing refactoring."), opening.text);
    assert.ok(opening.text.includes(`The queue's work: commits ${start}..${head} in this checkout`), opening.text);
    assert.match(opening.text, /What they changed \(git diff --stat\):\n Q1\.txt \| 1 \+\n Q2\.txt \| 1 \+\n 2 files changed, 2 insertions/);
    assert.ok(opening.text.includes(`The project's AGENTS.md has no "Refactoring" section: this text alone applies.`));
    assert.ok(opening.text.includes("If nothing is worth refactoring, make no commit and report the step done with your reasons in the summary"));

    // The report is the closing step's: only its opening asks for it, and it is there.
    assert.ok(opening.text.includes("This is the queue's last step."));
    assert.ok(!x.openings().find((o) => o.step === "Q2")!.text.includes("last step"), "the queue's own last step does not write it");
    assert.ok(existsSync(join(x.store.queueDir("Q"), "report.md")));
    assert.ok(x.queue().report);

    // Its round of commits begins where Q2's ended, and it made none.
    const rounds = x.store.readGit("Q")!.steps["Q.refactor"]!;
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]!.start, head);
    assert.equal(rounds[0]!.end, head);
  } finally { x.stop(); }
});

test("a revision that adds a step during the run still ends with the closing step", async () => {
  const hold = holdWork();
  const x = setup([step("Q1", "slow")]);
  try {
    x.engine().start("Q", { runtime: "claude" });
    await x.until("Q1 at work", () => x.queue().steps[0]!.status === "running");
    applyDraft(x.store, { id: "Q", title: "Queue", stop_conditions: [], checks: [], steps: [step("Q1", "slow"), step("Q2", "done")] });
    approveQueue(x.store, "Q");
    assert.deepEqual(x.queue().steps.map((s) => s.id), ["Q1", "Q2", "Q.refactor"]);
    hold.release();
    await x.until("the run finished", () => x.queue().run?.state === "finished");
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q2", "Q.refactor"]);
    assert.equal(x.queue().status, "done");
    // Without git: no range, and the text says where to look instead.
    assert.ok(x.openings().at(-1)!.text.includes("Nexus has no commit range of the queue's work"));
  } finally { hold.done(); x.stop(); }
});

test("once the closing step has run, a revision's new step makes it run again at the end", async () => {
  const x = setup([step("Q1", "done")]);
  try {
    const e = x.engine();
    e.start("Q", { runtime: "claude" });
    await x.until("the first run finished", () => x.queue().run?.state === "finished" && x.queue().status === "done");
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q.refactor"]);
    const first = x.queue().run!.started_at;

    applyDraft(x.store, { id: "Q", title: "Queue", stop_conditions: [], checks: [], steps: [step("Q1", "done"), step("Q2", "done")] });
    approveQueue(x.store, "Q");
    assert.notEqual(x.queue().status, "done");
    e.start("Q", { runtime: "claude" });
    await x.until("the second run finished", () => x.queue().run?.started_at !== first && x.queue().run?.state === "finished");
    assert.deepEqual(x.openings().map((o) => o.step), ["Q1", "Q.refactor", "Q2", "Q.refactor"]);
    const q = x.queue();
    assert.equal(q.status, "done");
    assert.deepEqual(q.steps.map((s) => s.id), ["Q1", "Q2", "Q.refactor"]);
    assert.equal(q.steps.at(-1)!.segments.length, 2);
    assert.equal(q.run!.switches?.at(-1)?.why, "refactor", "again in a fresh session");
  } finally { x.stop(); }
});

test("the commit range spans the queue's own rounds; a Refactoring section in AGENTS.md is found", () => {
  const x = setup([step("Q1", "done")], { git: true, rules: true });
  const a = x.git("rev-parse", "HEAD");
  writeFileSync(join(x.root, "b.txt"), "b\n"); x.git("add", "b.txt"); x.git("commit", "-qm", "b");
  const b = x.git("rev-parse", "HEAD");
  writeFileSync(join(x.root, "c.txt"), "c\n"); x.git("add", "c.txt"); x.git("commit", "-qm", "c");
  const c = x.git("rev-parse", "HEAD");
  const t = (s: number) => new Date(Date.parse(now()) + s * 1000).toISOString();
  x.store.writeGit("Q", { protocol: 1, steps: {
    Q1: [{ session: "s", start: a, started_at: t(0), end: b, ended_at: t(1) }],
    Q2: [{ session: "s", start: b, started_at: t(2), end: c, ended_at: t(3) }],
    // The closing step's own round is not the queue's work.
    "Q.refactor": [{ session: "s2", start: c, started_at: t(4), end: c, ended_at: t(5) }],
  } });
  const ctx = closingContext(x.store, x.queue());
  assert.deepEqual(ctx.range, { from: a, to: c });
  assert.match(ctx.stat!, /b\.txt \| 1 \+\n c\.txt \| 1 \+\n 2 files changed, 2 insertions/);
  assert.equal(ctx.rules, true);
  assert.equal(hasRefactoringSection(join(x.root, "nowhere")), false);
  writeFileSync(join(x.root, "AGENTS.md"), "# Rules\n\nRefactoring is welcome.\n");
  assert.equal(hasRefactoringSection(x.root), false, "only a heading counts");
});

// Snapshot tests of the texts agents receive (queue R3): the worker's briefing, the step-opening text, the inbox
// entries as delivered, the fresh-session seed and the nudges (engine); the orchestrator's briefing, its helpers'
// prompts and its notices; the thinking partner's briefing. They are what agents rely on (the reason for the Agents:
// lines), so a change to one is a decision: it shows here as a changed golden file.
//
// Each test drives the real engine, orchestrator or conversations with fixed inputs; the agents' processes are
// stand-ins (AgentHostOptions.spawn) that record what they were started with and every text sent to them. What the
// stand-ins received is compared with golden files (test/golden/prompts-<who>.txt) using assert.equal. Date is frozen
// (node:test's mock timers, Date only) and moved by the test; what differs per run (session ids, the temporary root,
// the report file's path) is written as a placeholder.
//
// To write the golden files anew (only for a decided change of a text):
// NEXUS_UPDATE_GOLDEN=1 node --test apps/server/test/prompts.test.ts
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore, addNote, answerAsUser, approveQueue, ensureNexusSession, ensureUserSession, loadProjectState, newId, now, reportFile, resetClock, sendMessage,
  type Event, type QueueFile, type SessionFile, type StepDef,
} from "@nexus/protocol";
import type { AgentEvents, AgentProcess, Priority } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { Engine } from "../src/engine.ts";
import { formatInbox, freshSessionSeed, helperBriefing, helperPacket, midStepSeed, noOutcomeNudge, stepOpening, switchReason } from "../src/prompts.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import type { DeployChanges } from "../src/deploy.ts";
import type { UpdateNotice } from "../src/lifecycle.ts";
import { acceptReviews } from "./fake-reviewer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse("2026-01-01T09:00:00.000Z");

/** A stand-in for an agent's process: records its launch and what it is sent; its state is set by the test. */
class Stand extends EventEmitter<AgentEvents> implements AgentProcess {
  state: AgentProcess["state"] = "idle";
  readonly pid = 4242;
  readonly launch: Launch;
  private readonly heard: (p: Stand, text: string, priority?: Priority) => void;
  constructor(launch: Launch, heard: (p: Stand, text: string, priority?: Priority) => void) { super(); this.launch = launch; this.heard = heard; }
  send(text: string, priority?: Priority): void { this.heard(this, text, priority); }
  stop(): boolean { return false; }
  close(): void { this.state = "exited"; }
  kill(): void { this.state = "exited"; }
}

/** What the stand-ins received, as the text of a golden file. */
class Transcript {
  private readonly parts: string[] = [];
  readonly stands: Stand[] = [];
  private readonly role: string;
  constructor(role: string) { this.role = role; }
  spawn = (launch: Launch): AgentProcess => {
    const p = new Stand(launch, (s, text, priority) => this.parts.push(`-- to ${this.name(s)}${priority ? ` (${priority})` : ""}\n${text}\n`));
    this.stands.push(p);
    return p;
  };
  /** The stand-in's name: by the order the processes were started. */
  name(p: Stand): string { return `${this.role} ${this.stands.indexOf(p) + 1}`; }
  section(label: string): void { this.parts.push(`== ${label}\n`); }
  add(text: string): void { this.parts.push(`${text}\n`); }
  /** Placeholders for what differs per run: [value, placeholder] pairs, longest values first. */
  text(replace: [string, string][]): string {
    let t = this.parts.join("");
    for (const [v, p] of [...replace].sort((a, b) => b[0].length - a[0].length)) t = t.replaceAll(v, p);
    return t;
  }
}

function golden(name: string, actual: string): void {
  const file = join(here, "golden", `prompts-${name}.txt`);
  if (process.env.NEXUS_UPDATE_GOLDEN) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, actual); }
  assert.equal(actual, readFileSync(file, "utf8"));
}

function setup(t: TestContext, name: string) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  resetClock(); // each case starts again at T0: a clock set back on purpose (clock.ts)
  const root = mkdtempSync(join(tmpdir(), `nexus-prompts-${name}-`));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "Pilot", root });
  /** Moves the frozen time on a minute: every file written after it is later than what came before. */
  const later = () => t.mock.timers.setTime(Date.now() + 60_000);
  /** An event of a session, as the `nexus` CLI writes it. */
  const event = (session: string, e: Record<string, unknown>) => { later(); store.appendEvent({ v: 1, id: newId(), at: now(), session, ...e } as Event); };
  const queue = (q: Partial<QueueFile> & { id: string; steps: StepDef[] }) =>
    store.writeQueue({ protocol: 1, title: `Queue ${q.id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [], ...q } as QueueFile);
  return { root, store, later, event, queue };
}

test("the worker's texts: briefing, step openings, inbox entries, seeds and nudges match the golden file", (t) => {
  const { root, store, later, event, queue } = setup(t, "worker");
  const p = store.readProject();
  store.writeProject({ ...p, defaults: { ...p.defaults, stop_conditions: ["The project's own stop condition."], context_care: true,
    checks: ["npm run lint", "npm test"] } }); // the project's checks: listed first, npm test once
  queue({
    id: "Q", title: "Prompts under test", description: "Context the worker needs.\nOn two lines.\n",
    checks: ["npm run typecheck", "npm test"], stop_conditions: ["A file outside the repository would change."],
    steps: [
      { id: "A1", title: "First step", goal: "Do the first thing.\nPrecisely.", acceptance: ["It is done", "It is tested"], review: { prepare: "Before/after shots of the page" } },
      { id: "A2", title: "Second step", goal: "Do the second thing.", acceptance: [], activities: ["feature", "test"], size: "M", origin: "user" },
      { id: "A3", title: "Third step", goal: "", acceptance: ["Third acceptance"] },
      { id: "A4", title: "Last step on Codex", goal: "Do the last thing.", acceptance: ["Last acceptance"], runtime: "codex" },
    ],
  });
  approveQueue(store, "Q");
  addNote(store, "Q", "A1", "Mind the second page.");

  const tr = new Transcript("worker");
  const engine = new Engine(store, () => {}, { spawn: tr.spawn });
  t.after(() => engine.shutdown());
  const change = () => { acceptReviews(store); engine.onChange(loadProjectState(store)); };
  const worker = () => store.readRun("Q")!.session;
  const stand = () => tr.stands.at(-1)!;

  tr.section("start: the first step opens");
  engine.start("Q");
  const briefing = (tr.stands[0]!.launch.options as { appendSystemPrompt: string }).appendSystemPrompt;
  event(worker(), { type: "step.started", queue: "Q", step: "A1" });

  tr.section("the turn ends without an outcome: the nudge");
  change();

  tr.section("a blocking question answered by the user, to wait for further word");
  event(worker(), { type: "question.asked", queue: "Q", step: "A1", qid: "q1", text: "Which page first?", options: ["the first", "the second"], can_continue: false });
  later();
  answerAsUser(store, "q1", "The second one.", false);
  change();

  tr.section("messages from the user: about the step, and not");
  later(); sendMessage(store, worker(), "Use the new colours.", { queue: "Q", step: "A1" });
  later(); sendMessage(store, worker(), "A general remark.");
  change();

  tr.section("stops through the inbox: with a text from the user, without one from the orchestrator");
  later(); store.appendInbox(worker(), { v: 1, id: newId(), at: now(), from: "user", type: "stop", text: "The plan changed" });
  later(); store.appendInbox(worker(), { v: 1, id: newId(), at: now(), from: "orchestrator", type: "stop" });
  change();

  tr.section("the user stops the running turn: with a text, then without one");
  stand().state = "working";
  later(); engine.stopNow("Q", "Wrong branch");
  later(); engine.stopNow("Q");
  stand().state = "idle";

  tr.section("resumed with a reason: the step continues");
  later(); engine.resume("Q", "the user resumed it");
  change(); // Resume releases the saved answer batch; the watcher delivers it before the next outcome.

  tr.section("the first step done: the second opens");
  event(worker(), { type: "step.done", queue: "Q", step: "A1", summary: "The first thing is done." });
  change();
  event(worker(), { type: "step.started", queue: "Q", step: "A2" });
  stand().emit("facts", { contextTokens: 900, contextWindow: 1000 });

  tr.section("the second step done with the context 90 % full: the summary is asked for");
  event(worker(), { type: "step.done", queue: "Q", step: "A2", summary: "The second thing is done." });
  change();

  tr.section("the summary written, a message not yet read: a fresh session is seeded with both");
  event(worker(), { type: "context.summary", queue: "Q", step: "A2", text: "Decided: the second page first.", topics: ["pages", "colours"], files: ["src/page.ts"] });
  const before = loadProjectState(store);
  later(); sendMessage(store, worker(), "This came while the step ended.");
  engine.onChange(before);
  event(worker(), { type: "step.started", queue: "Q", step: "A3" });

  tr.section("the third step done, the last runs on Codex: the summary is asked for");
  event(worker(), { type: "step.done", queue: "Q", step: "A3", summary: "The third thing is done." });
  change();

  tr.section("no summary written: a fresh Codex session is seeded from the queue");
  later(); change();
  const codex = (stand().launch.options as { instructions: string }).instructions;
  event(worker(), { type: "step.started", queue: "Q", step: "A4" });

  tr.section("sent back: by the user (a step with acceptance), by the orchestrator (one without)");
  later(); store.appendInbox(worker(), { v: 1, id: newId(), at: now(), from: "user", type: "send_back", ref: "r1", queue: "Q", step: "A1", text: "The second page is still wrong.", round: 2 });
  later(); store.appendInbox(worker(), { v: 1, id: newId(), at: now(), from: "orchestrator", type: "send_back", ref: "r2", queue: "Q", step: "A2", text: "The test is missing.", round: 3 });
  change();

  tr.section("the last step failed and is resumed: it continues with what it was left at");
  event(worker(), { type: "step.failed", queue: "Q", step: "A4", reason: "The build tool is missing." });
  change();
  later(); engine.resume("Q");

  tr.section("the nudges after background work (DESIGN.md, \"Background work\"; noOutcomeNudge): it has finished; it still runs after the limit");
  tr.add(noOutcomeNudge("A1", { finished: true }));
  tr.add(noOutcomeNudge("A1", { finished: false, minutes: 30, work: ["Run the e2e suite", "sub-agent /root/review"] }));

  tr.section("the closing refactoring step of a queue with coding: true, in its fresh session: the seed, then its opening with the commit range and a Refactoring section in AGENTS.md");
  queue({ id: "C", title: "Coding queue", coding: true, checks: ["npm test"], steps: [{ id: "C1", title: "The code", goal: "Write it.", acceptance: [] }] });
  later(); approveQueue(store, "C");
  event(worker(), { type: "step.started", queue: "C", step: "C1" });
  event(worker(), { type: "step.done", queue: "C", step: "C1", summary: "The code is written." });
  const cq = loadProjectState(store).queues.find((x) => x.id === "C")!;
  const closing = cq.steps.at(-1)!;
  tr.add(freshSessionSeed(cq, switchReason("refactor", closing.id, "claude", "claude", undefined), cq.steps[0], closing, undefined));
  const open = (c: Parameters<typeof stepOpening>[0]["closing"]) => stepOpening({
    q: cq, step: closing, mode: "start", projectStopConditions: [], notes: [], answers: [], last: true, report: "<report file>", closing: c,
  });
  tr.add(open({ range: { from: "1111111111111111111111111111111111111111", to: "2222222222222222222222222222222222222222" }, stat: [" src/code.ts | 12 +++++++-----", " 1 file changed, 7 insertions(+), 5 deletions(-)"].join("\n"), rules: true }));
  tr.section("the closing refactoring step without git records, and without a Refactoring section");
  tr.add(open({ rules: false }));

  tr.section("the closing refactoring step whose checks Nexus runs (P12): with the commit they last passed on, and without");
  const byNexus = (c: Parameters<typeof stepOpening>[0]["closing"]) => stepOpening({
    q: cq, step: closing, mode: "start", projectStopConditions: [], notes: [], answers: [], last: true, report: "<report file>", closing: c, checksByNexus: true,
  });
  tr.add(byNexus({ range: { from: "1111111111111111111111111111111111111111", to: "2222222222222222222222222222222222222222" }, rules: true, checked: "2222222222222222222222222222222222222222" }));
  tr.add(byNexus({ rules: false }));

  tr.section("checks run by Nexus (PROTOCOL.md, \"Checks run by Nexus\"): a step's opening, the integration step's (no conflict to resolve, one it may resolve)");
  const nq = loadProjectState(store).queues.find((x) => x.id === "Q")!;
  const opening = (integration?: Parameters<typeof stepOpening>[0]["integration"]) => stepOpening({
    q: nq, step: nq.steps[2]!, mode: "start", projectStopConditions: [], projectChecks: ["npm run lint", "npm test"], notes: [], answers: [], last: false,
    report: "<report file>", integration, checksByNexus: true,
  });
  tr.add(opening());
  tr.add(opening({ base: "main", sha: "4444444444444444444444444444444444444444", branch: "nexus/Q", resolve: false }));
  tr.add(opening({ base: "main", sha: "4444444444444444444444444444444444444444", branch: "nexus/Q", resolve: true }));

  tr.section("a step whose checks Nexus runs: a check-fix round, and a send-back (inbox entries)");
  store.writeChecks("C", { protocol: 1, steps: { C1: { by: "nexus", sets: [] } } });
  const ns = loadProjectState(store);
  tr.add(formatInbox({ v: 1, id: "check-failed-d1", at: now(), from: "nexus", type: "check_failed", ref: "d1", queue: "C", step: "C1", fix: 1,
    text: "Check \"npm test\" failed twice (exit code 1).\nFailing tests:\n- engine › halts after the fix limit\nFull log: <root>/.nexus/queues/C/checks/C1/r1f0-1-npm-test.2.log\nThe end of its output:\nnot ok 12 - halts after the fix limit" }, ns));
  tr.add(formatInbox({ v: 1, id: newId(), at: now(), from: "orchestrator", type: "send_back", ref: "r3", queue: "C", step: "C1", text: "The test is missing.", round: 2 }, ns));

  tr.section("a step taken over in its middle on its fallback (usage): with progress, commits and uncommitted files, and without");
  const mq = loadProjectState(store).queues.find((x) => x.id === "Q")!;
  const because = "Claude Code's 5-hour window at 95 % (limit 90 %), so the step goes on on Codex";
  tr.add(midStepSeed(mq, mq.steps[1]!, because, {
    progress: ["half way (50 %)", "tests written"], commits: ["1a2b3c4 A2 first half"],
    uncommitted: ["M src/a.ts", "?? src/b.ts"], diffstat: "1 file changed, 2 insertions(+)",
  }));
  tr.add(midStepSeed(mq, mq.steps[1]!, because, { progress: [], commits: [], uncommitted: [] }));

  tr.section("the worker's briefing (Claude Code: appended to the system prompt)");
  tr.add(briefing);
  tr.section("the worker's briefing for Codex (its instructions)");
  tr.add(codex === briefing ? "(the same text)" : codex);

  const sessions = store.sessionIds().map((id) => store.readSession(id)).filter((s) => s.role === "worker").sort((a, b) => a.created_at.localeCompare(b.created_at));
  golden("worker", tr.text([
    ...sessions.map((s, i) => [s.id, `<worker session ${i + 1}>`] as [string, string]),
    [reportFile("p", "Q"), "<report file>"],
    [root, "<root>"],
  ]));
});

test("the orchestrator's texts: briefing, helpers and notices match the golden file", (t) => {
  const { root, store, later, event, queue } = setup(t, "orchestrator");
  const p = store.readProject();
  store.writeProject({ ...p, defaults: { ...p.defaults, context_reuse_tokens: 200_000 } });
  const tr = new Transcript("orchestrator");
  let deploys: DeployChanges[] = [];
  let update: UpdateNotice | undefined;
  // The orchestrator's notices need no engine but its draining flag (no request of the orchestrator's is applied here).
  const engine = { draining: false } as unknown as Engine;
  const orchestrator = new Orchestrator(store, engine, () => {}, { update: () => update, changes: () => deploys }, { spawn: tr.spawn });
  t.after(() => orchestrator.shutdown());
  const change = () => orchestrator.onChange(loadProjectState(store));
  const deploy = (n: number, texts: string[]): DeployChanges => ({ key: `deploy:${n}`, at: now(), from: `${n}aaaaaaaaa`, to: `${n}bbbbbbbbb`, changes: texts.map((text, i) => ({ commit: `c${n}${i}`, text })) });
  const worker = (id: string, q?: string): string => {
    const s: SessionFile = { protocol: 1, id, project: "p", role: "worker", runtime: "claude", native_id: null, title: id, cwd: root, launched_by: "nexus", created_at: now(), queue: q };
    store.writeSession(s);
    return id;
  };
  const steps = (prefix: string, n = 1): StepDef[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, title: `Step ${prefix}${i + 1}`, goal: `Goal of ${prefix}${i + 1}.`, acceptance: [`${prefix}${i + 1} is done`] }));
  const run = (q: string, r: Record<string, unknown>) => store.writeRun(q, { protocol: 1, session: "w-run", started_at: now(), updated_at: now(), revision: 1, ...r } as never);
  const setNotify = (notify: boolean) => { const pr = store.readProject(); store.writeProject({ ...pr, orchestrator: { ...pr.orchestrator!, notify } }); };

  tr.section("the user's first message starts the orchestrator");
  orchestrator.say("Hello.");
  const orch = store.readProject().orchestrator!.session!;

  tr.section("a deploy's changes for agents, told with notices on");
  later(); deploys = [deploy(1, ["nexus status shows schedules", "A new briefing line"])];
  change();

  tr.section("with notices off a deploy's changes wait for the user's next message");
  later(); setNotify(false);
  deploys = [...deploys, deploy(2, ["nexus ask takes --step"])];
  change();
  orchestrator.say("What changed?");

  tr.section("the outcome of an update it ran, with the changes of the deploy");
  later(); deploys = [...deploys, deploy(3, ["nexus review accept takes --note"])];
  update = { key: "update:1", by: { project: "p", session: orch }, fact: "Nexus was updated to 3bbbbbb.", todo: "Tell the user the update is done." };
  change();
  setNotify(true);

  tr.section("workers' questions: with options, going on meanwhile; and without a queue, waiting");
  queue({ id: "QA", steps: steps("A") });
  worker("w-ask");
  event("w-ask", { type: "question.asked", queue: "QA", step: "A1", qid: "q-1", text: "Which layout?", options: ["grid", "list"], can_continue: true });
  event("w-ask", { type: "question.asked", qid: "q-2", text: "May I delete the old file?", can_continue: false });
  change();

  tr.section("approvals: no run; a run paused by a rejection; a run of an older revision; a paused run; a running one");
  later(); approveQueue(store, "QA");
  queue({ id: "QB", steps: steps("B", 2) }); approveQueue(store, "QB"); run("QB", { state: "paused", step: "B1", rejected: "B1", reason: "step B1 was rejected by the user" });
  queue({ id: "QC", steps: steps("C"), revision: 2, approvals: [{ revision: 1, at: now(), hash: "sha256:old" }] } as never);
  approveQueue(store, "QC"); run("QC", { state: "halted", step: "C1", reason: "it stalled", revision: 1 });
  queue({ id: "QD", steps: steps("D") }); approveQueue(store, "QD"); run("QD", { state: "paused", step: "D1", reason: "the server restarted" });
  queue({ id: "QE", steps: steps("E") }); approveQueue(store, "QE"); run("QE", { state: "running", step: "E1" });
  change();

  tr.section("a stop lifted with Continue; approvals withdrawn, with a reason and without");
  later();
  const qe = store.readQueue("QE");
  store.writeQueue({ ...qe, changes: [...qe.changes, { at: now(), kind: "lift", by: "user_continue", from: "stopped", to: "approved", reason: "condition: the disk is full", revision: 1 }] });
  queue({ id: "QF", steps: steps("F"), withdrawals: [{ revision: 1, at: now(), reason: "Not yet.", approvals: 1 }, { revision: 1, at: now(), approvals: 1 }] } as never);
  change();

  tr.section("a step waiting for the orchestrator's review (its second round)");
  later();
  queue({ id: "QG", steps: steps("G", 2), review_level: 2, checks: ["npm test", "npm run typecheck", "lint"] });
  approveQueue(store, "QG");
  worker("w-review", "QG");
  run("QG", { session: "w-review", state: "running", step: "G1" });
  event("w-review", { type: "step.started", queue: "QG", step: "G1" });
  event("w-review", { type: "step.done", queue: "QG", step: "G1", summary: "G1 in its first round.", commit: "aaa1111" });
  event(orch, { type: "review.sent_back", queue: "QG", step: "G1", text: "The test for the empty list is missing." });
  event("w-review", { type: "step.started", queue: "QG", step: "G1" });
  event("w-review", { type: "check.result", queue: "QG", step: "G1", name: "npm test", ok: true, summary: "112 pass", duration: 95.2 });
  event("w-review", { type: "check.result", queue: "QG", step: "G1", name: "npm run typecheck", ok: false });
  event("w-review", { type: "review.added", queue: "QG", step: "G1", items: [{ path: "shots/list.png", label: "The list", kind: "image" }, { url: "https://example.com/sheet" }] });
  event("w-review", { type: "step.done", queue: "QG", step: "G1", summary: "G1 with the test added.", commit: "bbb2222" });
  change();

  tr.section("the user's note on the step in the orchestrator's review");
  later(); addNote(store, "QG", "G1", "The list looks crowded.");
  change();

  tr.section("a missed schedule; runs paused by the user, halted (at a step and before one) and finished (with a report and without)");
  later();
  queue({ id: "QH", steps: steps("H") }); approveQueue(store, "QH");
  store.writeStart("QH", { protocol: 1, at: "2026-01-01T08:00:00.000Z", by: "orchestrator", revision: 1, created_at: now(), failed: { at: now(), reason: "missed: Nexus was not running at 09:00", missed: true } });
  queue({ id: "QI", steps: steps("I", 2) }); approveQueue(store, "QI"); run("QI", { state: "paused", step: "I1", reason: "paused by the user", ended_at: now() });
  queue({ id: "QJ", steps: steps("J") }); approveQueue(store, "QJ"); run("QJ", { state: "halted", step: "J1", reason: "step J1 failed: no disk", ended_at: now() });
  queue({ id: "QK", steps: steps("K") }); approveQueue(store, "QK"); run("QK", { state: "halted", ended_at: now() });
  queue({ id: "QL", steps: steps("L") }); approveQueue(store, "QL"); run("QL", { state: "finished", step: "L1", ended_at: now() });
  event(orch, { type: "queue.report", queue: "QL", path: "report.md", summary: "Everything went to plan." });
  queue({ id: "QM", steps: steps("M") }); approveQueue(store, "QM"); run("QM", { state: "finished", step: "M1", ended_at: now() });
  change();

  tr.section("maintenance runs finished: with findings (told once, with the report's path) and without (nothing)");
  later();
  queue({ id: "MF", steps: steps("MF"), maintenance: "survey" }); approveQueue(store, "MF"); run("MF", { state: "finished", step: "MF1", ended_at: now() });
  event(orch, { type: "queue.report", queue: "MF", path: "<root>/.nexus/queues/MF/report.md", summary: "Two outdated packages.", findings: 2 });
  queue({ id: "MZ", steps: steps("MZ"), maintenance: "fix_small" }); approveQueue(store, "MZ"); run("MZ", { state: "finished", step: "MZ1", ended_at: now() });
  event(orch, { type: "queue.report", queue: "MZ", path: "<root>/.nexus/queues/MZ/report.md", summary: "Nothing found.", findings: 0 });
  change();

  tr.section("the user's review decisions: accepted with a note (a step and the last), rejected (with a reason and without), a stopped step's work discarded");
  later();
  queue({ id: "QN", steps: steps("N", 2), review_level: 1 }); approveQueue(store, "QN");
  worker("w-user", "QN");
  for (const st of ["N1", "N2"]) {
    event("w-user", { type: "step.started", queue: "QN", step: st });
    event("w-user", { type: "step.done", queue: "QN", step: st, summary: `${st} done.` });
  }
  const user = ensureUserSession(store).id;
  event(user, { type: "review.accepted", queue: "QN", step: "N1", text: "Keep the old names.", to: "orchestrator" });
  event(user, { type: "review.accepted", queue: "QN", step: "N2", text: "Next time smaller steps.", to: "orchestrator" });
  queue({ id: "QO", steps: steps("O", 2), review_level: 1 }); approveQueue(store, "QO");
  worker("w-rej", "QO");
  for (const st of ["O1", "O2"]) {
    event("w-rej", { type: "step.started", queue: "QO", step: st });
    event("w-rej", { type: "step.done", queue: "QO", step: st, summary: `${st} done.` });
  }
  event(user, { type: "review.rejected", queue: "QO", step: "O1", text: "The colours are wrong." });
  event(user, { type: "review.rejected", queue: "QO", step: "O2" });
  queue({ id: "QP", steps: steps("P") });
  const qp = store.readQueue("QP");
  store.writeQueue({ ...qp, changes: [
    { at: now(), kind: "work", by: "user_continue", step: "P1", from: "stopped", to: "discarded", commits: ["ccc3333", "ddd4444"] },
    { at: now(), kind: "work", by: "user_continue", step: "P1", from: "stopped", to: "discarded", commits: ["eee5555"] },
  ] });
  change();

  tr.section("the user's decisions on tag proposals: an area accepted, an activity declined, a rename accepted");
  later();
  const proposal = (id: string, kind: "area" | "activity" | "rename", name: string, from?: string) => ({ id, at: now(), kind, name, ...(from ? { from } : {}), reason: "Why." });
  store.writeTags({
    protocol: 1, prefix: "p", areas: [{ name: "core", at: now() }], activities: [], renames: [{ from: "engine", to: "core", at: now() }], proposals: [],
    decisions: [
      { at: now(), accepted: true, proposal: proposal("t-1", "area", "engine") },
      { at: now(), accepted: false, proposal: proposal("t-2", "activity", "p:terrain") },
      { at: now(), accepted: true, proposal: proposal("t-3", "rename", "core", "engine") },
    ],
  });
  change();

  tr.section("a turn an update's hand-over cut off goes on after the restart, quoting the user's message it answered");
  later();
  const cut = tr.stands.at(-1)!;
  cut.emit("turnEnd", { ok: true, text: "" }); // its earlier turns are over
  cut.state = "working";
  orchestrator.say("Plan the layout.\nTwo columns, please.");
  orchestrator.cutOff();
  cut.state = "idle";
  orchestrator.resumeCutOff();

  tr.section("the orchestrator's briefing (appended to the system prompt)");
  const options = tr.stands[0]!.launch.options as { appendSystemPrompt: string; agentsFile: string };
  tr.add(options.appendSystemPrompt);
  tr.section("the orchestrator's helpers (--agents)");
  tr.add(readFileSync(options.agentsFile, "utf8"));

  golden("orchestrator", tr.text([[orch, "<orchestrator session>"], [root, "<root>"]]));
});

test("the review helper's texts: its briefing, its packet, the notices after a pass-on, and what rides with a notice match the golden file", (t) => {
  const { root, store, event, queue } = setup(t, "helper");
  const p = store.readProject();
  // Every acceptance of the helper audited (the rate decides it with the event id's hash; 1: all).
  store.writeProject({ ...p, review_helper: { ...p.review_helper, audit_rate: 1 } });
  const tr = new Transcript("orchestrator");
  // Without helpers of its own: the helper sessions and their verdicts are written here, as their CLI would.
  const orchestrator = new Orchestrator(store, { draining: false } as unknown as Engine, () => {}, {}, { spawn: tr.spawn });
  t.after(() => orchestrator.shutdown());
  const change = () => orchestrator.onChange(loadProjectState(store));
  orchestrator.say("Hello.");
  const orch = store.readProject().orchestrator!.session!;
  queue({ id: "QH", review_level: 2, steps: [
    { id: "H1", title: "Step H1", goal: "Goal of H1.", acceptance: ["H1 is done"] },
    { id: "H2", title: "Step H2", goal: "Goal of H2.", acceptance: ["H2 is done", "The look is calm"], review: { prepare: "The calm look: compare with the mockup." } },
    { id: "H3", title: "Step H3", goal: "Goal of H3.", acceptance: ["H3 is done"], review: { level: 3 } },
  ] });
  approveQueue(store, "QH");
  store.writeSession({ protocol: 1, id: "w-h", project: "p", role: "worker", runtime: "claude", native_id: null, title: "w-h", cwd: root, launched_by: "nexus", created_at: now(), queue: "QH" });
  const helper = (id: string, step: string, round: number, level: 2 | 3) => store.writeSession({
    protocol: 1, id, project: "p", role: "helper", runtime: "claude", native_id: null, cwd: root, launched_by: "nexus", created_at: now(),
    model: "claude-sonnet-5-5", effort: "medium", about: { queue: "QH", step, round, level },
  });
  const step = (id: string) => loadProjectState(store).queues.find((q) => q.id === "QH")!.steps.find((x) => x.id === id)!;

  tr.section("H1: the worker sends it back after the helper's send-back, and the helper accepts round 2");
  event("w-h", { type: "step.started", queue: "QH", step: "H1" });
  event("w-h", { type: "step.done", queue: "QH", step: "H1", summary: "H1 in its first round.", commit: "aaa1111" });
  helper("h-1", "H1", 1, 2);
  event("h-1", { type: "review.sent_back", queue: "QH", step: "H1", text: "The test for the empty list is missing.\nAdd it beside the others." });
  // The send-back delivered, as the server does (routeSendBacks): round 2 opens.
  store.appendInbox("w-h", { v: 1, id: "send-back-x", at: now(), from: "helper", type: "send_back", ref: step("H1").sent_back[0]!.id, queue: "QH", step: "H1", text: "The test for the empty list is missing.", round: 2 });
  event("w-h", { type: "step.started", queue: "QH", step: "H1" });
  event("w-h", { type: "step.done", queue: "QH", step: "H1", summary: "H1 with the test.", commit: "aaa2222" });
  helper("h-2", "H1", 2, 2);
  event("h-2", { type: "review.accepted", queue: "QH", step: "H1", text: "Both criteria checked in the diff and the test file." });

  tr.section("the review helper's briefing");
  tr.add(helperBriefing(store.readProject()));

  tr.section("H2: its packet, with the review notes, the checks reported and the diff's summary");
  event("w-h", { type: "step.started", queue: "QH", step: "H2" });
  event("w-h", { type: "check.result", queue: "QH", step: "H2", name: "npm test", ok: true, summary: "112 pass", duration: 95.2 });
  event("w-h", { type: "step.done", queue: "QH", step: "H2", summary: "H2 done; the colours differ from the plan (left out: the dark theme).", commit: "bbb1111" });
  const state = loadProjectState(store);
  const qh = state.queues.find((q) => q.id === "QH")!;
  tr.add(helperPacket(qh, step("H2"), {
    stat: " src/a.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)", diff: join(root, "sessions", "h-3", "diff.patch"),
    range: { from: "aaa2222", to: "bbb1111", round: { from: "aaa2222", to: "bbb1111" } }, queueDir: join(root, ".nexus", "queues", "QH"),
  }));

  tr.section("H2 passed on by the helper (a criterion, a deviation): the review notice, with H1's acceptance and its audit riding with it");
  helper("h-3", "H2", 1, 2);
  event("h-3", { type: "review.passed_on", queue: "QH", step: "H2", round: 1, reasons: ["criterion", "deviation"], text: "H2 is done: checked in the diff. The calm look cannot be judged from the packet; the summary leaves out the dark theme." });
  change();

  tr.section("H3 (level 3) passed on by Nexus without a helper: its runtime is beyond the usage threshold");
  event(orch, { type: "review.accepted", queue: "QH", step: "H2" });
  event("w-h", { type: "step.started", queue: "QH", step: "H3" });
  event("w-h", { type: "step.done", queue: "QH", step: "H3", summary: "H3 done.", commit: "ccc1111" });
  ensureNexusSession(store);
  event("nexus", { type: "review.passed_on", queue: "QH", step: "H3", round: 1, reasons: ["unavailable"], text: "The review helper's runtime is beyond the usage threshold: five_hour at 95 %." });
  change();

  golden("helper", tr.text([[orch, "<orchestrator session>"], [root.replaceAll("\\", "/"), "<root>"], [root, "<root>"]]));
});

test("the orchestrator's context care: the summary request, the fresh session's first message and summary.md match the golden file", (t) => {
  const { root, store, later, event, queue } = setup(t, "orchestrator-fresh");
  const tr = new Transcript("orchestrator");
  const orchestrator = new Orchestrator(store, { draining: false } as unknown as Engine, () => {}, {}, { spawn: tr.spawn });
  t.after(() => orchestrator.shutdown());
  const change = () => orchestrator.onChange(loadProjectState(store));
  queue({ id: "QA", title: "The planned work", steps: [{ id: "A1", title: "Step A1", goal: "Goal of A1.", acceptance: ["A1 is done"] }] });
  approveQueue(store, "QA");

  tr.section("the user's first message starts the orchestrator");
  orchestrator.say("Hello.");
  const old = store.readProject().orchestrator!.session!;

  tr.section("its turn ended with its context 90 % full: the summary is asked for");
  later(); store.writeRuntime(old, { state: "idle", context_tokens: 900, context_window: 1000, turns: 0, updated_at: now() });
  change();

  tr.section("the user writes meanwhile: the message waits for the fresh session");
  later(); orchestrator.say("Also: the release is on Friday.");

  tr.section("the summary written, the turn over: the fresh session starts from it");
  event(old, { type: "context.summary", text: "Decided: two columns. Open: the colours. Plan: QA next. Promised: a digest on Friday.", topics: ["layout", "plan"], files: ["docs/plan.md"] });
  change();
  const fresh = store.readProject().orchestrator!.session!;

  tr.section("the chat lines Nexus wrote: the old session's, then the fresh one's");
  for (const id of [old, fresh]) for (const c of store.readChat(id).entries) if (c.from !== "orchestrator") tr.add(`${c.from}: ${c.text}`);
  tr.section(".nexus/orchestrator/summary.md");
  tr.add(readFileSync(store.orchestratorSummaryFile, "utf8"));

  golden("orchestrator-fresh", tr.text([[fresh, "<fresh session>"], [old, "<orchestrator session>"], [root, "<root>"]]));
});

test("the orchestrator on Codex: its briefing without helpers, its sandbox, and the runtime switch's first message match the golden file", (t) => {
  const { root, store, later, queue } = setup(t, "orchestrator-codex");
  const p = store.readProject();
  store.writeProject({ ...p, orchestrator: { notify: true, session: null, runtime: "codex" } });
  const tr = new Transcript("orchestrator");
  const orchestrator = new Orchestrator(store, { draining: false } as unknown as Engine, () => {}, {}, { spawn: tr.spawn });
  t.after(() => orchestrator.shutdown());
  queue({ id: "QA", title: "The planned work", steps: [{ id: "A1", title: "Step A1", goal: "Goal of A1.", acceptance: ["A1 is done"] }] });

  tr.section("the user's first message starts the orchestrator on Codex");
  orchestrator.say("Hello.");
  const first = store.readProject().orchestrator!.session!;
  const { instructions, ...launch } = tr.stands[0]!.launch.options as unknown as { instructions: string } & Record<string, unknown>;
  tr.section("its launch (CodexOptions; the environment left out)");
  tr.add(JSON.stringify({ runtime: tr.stands[0]!.launch.runtime, ...launch, env: undefined }, null, 2));
  tr.section("its briefing (developer instructions)");
  tr.add(instructions);

  tr.section("the user switches it to Claude Code and writes: a fresh session starts from the project's state");
  later();
  const pr = store.readProject();
  store.writeProject({ ...pr, orchestrator: { ...pr.orchestrator!, runtime: "claude" } });
  orchestrator.say("Back on Claude.");
  const second = store.readProject().orchestrator!.session!;
  tr.section("the chat lines Nexus wrote: the old session's, then the fresh one's");
  for (const id of [first, second]) for (const c of store.readChat(id).entries) if (c.from === "nexus") tr.add(`${c.from}: ${c.text}`);

  golden("orchestrator-codex", tr.text([[second, "<fresh session>"], [first, "<orchestrator session>"], [JSON.stringify(root).slice(1, -1), "<root>"], [root.replaceAll("\\", "/"), "<root>"], [root, "<root>"]]));
});

test("the thinking partner's briefing and hand-over, with a notes folder and without, at each web level, match the golden file", (t) => {
  const { root, store } = setup(t, "partner");
  const tr = new Transcript("partner");
  const orchestrator = new Orchestrator(store, { draining: false } as unknown as Engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {}, { spawn: tr.spawn });
  t.after(() => orchestrator.shutdown());
  for (const [label, notes, runtime, web] of [
    ["with a notes folder (Claude Code), web search", "docs/notes", "claude", "search"],
    ["without one (Codex), no web", undefined, "codex", "off"],
    ["with a notes folder (Claude Code), web search and pages", "docs/notes", "claude", "fetch"],
  ] as const) {
    const p = store.readProject();
    store.writeProject({ ...p, conversations: { ...p.conversations, notes_dir: notes, web } });
    const s = conversations.create({ title: label, runtime });
    tr.section(`the partner's briefing, ${label}`);
    conversations.say(s.id, "Let us think.");
    const o = tr.stands.at(-1)!.launch.options as { appendSystemPrompt?: string; instructions?: string };
    tr.add(o.appendSystemPrompt ?? o.instructions ?? "(none)");
    // The hand-over's instruction: with a notes folder it asks for the record of the entries covered (nexus covers).
    if (web !== "fetch") { tr.section(`the hand-over, ${label}`); conversations.handoff(s.id); }
  }
  golden("partner", tr.text([[root.replaceAll("\\", "/"), "<root>"], [root, "<root>"]]));
});

test("the briefings carry the review standard's essentials and point to nexus help review", async () => {
  const { WORKER_BRIEFING, orchestratorBriefing } = await import("../src/prompts.ts");
  for (const part of ["read `nexus help review` before you prepare it", "--key <view@width> --role <role>", "waiting-tab@492",
    "before (the old state), mockup (the design), after (the new state), variant-a / variant-b (alternatives), result", "fixed-viewport", "Nexus refuses a wrong pair"]) {
    assert.ok(WORKER_BRIEFING.includes(part), `the worker's briefing has ${JSON.stringify(part)}`);
  }
  const orch = orchestratorBriefing("Pilot", 300_000);
  for (const part of ["`nexus help review` (read it before you write a review.prepare)", "In review.prepare name the views with their keys and roles", "waiting-tab@492 before -> after"]) {
    assert.ok(orch.includes(part), `the orchestrator's briefing has ${JSON.stringify(part)}`);
  }
});

test("the three briefings, on each runtime, say how to read and how to run and chain nexus and git commands (queues SH, BR)", async () => {
  const { WORKER_BRIEFING, orchestratorBriefing, partnerBriefing, workerBriefing, shellCommands, readingRules } = await import("../src/prompts.ts");
  const project = { name: "P", root: "/p", languages: { working: "en" } } as unknown as Parameters<typeof partnerBriefing>[0];
  for (const runtime of ["claude", "codex"] as const) {
    const roles = { worker: workerBriefing({ working: "en" }, runtime), orchestrator: orchestratorBriefing("Pilot", 300_000, undefined, 500_000, runtime), partner: partnerBriefing(project, undefined, runtime) };
    for (const [who, text] of Object.entries(roles)) {
      for (const rule of [shellCommands(runtime), readingRules(runtime)]) assert.equal(text.split(rule).length, 2, `the ${who}'s briefing on ${runtime} says it once`);
      for (const part of ["as parallel tool calls", "nexus doc <file.md#section>", "only by exception", "never two builds or test runs at once", "a; if ($?) { b }", "a && b", "never in one chain"]) {
        assert.ok(text.includes(part), `the ${who}'s briefing on ${runtime} has ${JSON.stringify(part)}`);
      }
      assert.ok(text.includes(runtime === "codex" ? "Find with rg, with context lines (-C)" : "Find with Grep, with context lines (-C) and a head_limit, and read a known range with Read's offset and limit"), `the ${who}'s briefing reads in part on ${runtime}`);
      assert.ok(!text.includes("no cd, no &&"), `the ${who}'s briefing on ${runtime} no longer forbids a chain`);
    }
  }
  const partner = partnerBriefing(project, undefined);
  const briefings = { worker: WORKER_BRIEFING, orchestrator: orchestratorBriefing("Pilot", 300_000), partner };
  assert.ok(WORKER_BRIEFING.includes("- When an action is refused, do not work around it through another tool or command that reaches the same end (PowerShell after Bash, the shell after the edit tool); retry once in a simpler form at most (without chaining, for example), otherwise report what you needed and why.\n"));
  assert.ok(briefings.orchestrator.includes("\nWhen an action is refused, do not work around it through another tool or command that reaches the same end (PowerShell after Bash, for example); retry once in a simpler form at most, otherwise tell the user what you needed and why (`nexus help refusals`).\n"));
  assert.ok(partner.endsWith("\n- When an action is refused, do not work around it through another tool or command that reaches the same end; retry once in a simpler form at most, otherwise tell the user what you needed and why (`nexus help refusals`)."));
});

test("the worker looks at one width and reports progress at phase boundaries; the orchestrator puts small items together (queue BR)", async () => {
  const { workerBriefing, orchestratorBriefing } = await import("../src/prompts.ts");
  for (const runtime of ["claude", "codex"] as const) {
    const worker = workerBriefing({ working: "en" }, runtime);
    assert.ok(worker.includes("Look at a changed view yourself at one width"), `the ${runtime} worker looks at one width`);
    assert.ok(worker.includes("you only register for the review (nexus review add), without opening them again"));
    assert.ok(worker.includes("at a phase boundary only"), `the ${runtime} worker reports progress at phase boundaries`);
    assert.ok(orchestratorBriefing("Pilot", 300_000, undefined, 500_000, runtime).includes("go into one queue, each as a step of its own (at most about five steps)"), `the ${runtime} orchestrator puts small items together`);
  }
});

test("the orchestrator's briefing and notices on parallel worktrees and merging back (queue PW)", async () => {
  const { orchestratorBriefing, mergeWaitNotice, mergedNotice } = await import("../src/prompts.ts");
  const orch = orchestratorBriefing("Pilot", 300_000);
  for (const part of [
    "give a queue a worktree of its own (worktree: auto) when its work is independent",
    "queues that touch the same code run one after another (put them in the plan in order), never side by side",
    "id <queue>.integrate, review level 2",
    "a worker is started only for a conflict the project's resolve_conflicts setting lets it resolve, or for a failing check",
    // Queue MI: the integration step without a model, the report's writer, and the checks it rests on.
    "without a model when the merge is clean, and accepts the step itself when every check passes",
    "The queue's report is written by the step before the integration step",
    "give such a queue checks that cover the typecheck, the tests and, where the work touches it, the build",
    "Merging the queue back into main is Nexus's own only where the project's merge_back setting is on",
    "with the setting off it is the user's (Merge back in the dashboard). Never merge, rebase or move main yourself.",
  ]) assert.ok(orch.includes(part), `the orchestrator's briefing has ${JSON.stringify(part)}`);
  const q = { id: "W", title: "Work" } as Parameters<typeof mergeWaitNotice>[0];
  const wait = mergeWaitNotice(q, "C:/p has uncommitted changes: commit or stash them, then merge");
  assert.equal(wait.fact, "Queue W is not merged back yet: C:/p has uncommitted changes: commit or stash them, then merge");
  assert.match(wait.todo, /Do not touch the base's checkout yourself/);
  // A run Nexus held for the merge back and let go on when it could not go (queue FX).
  assert.equal(mergeWaitNotice(q, "C:/p has uncommitted changes", ["M"]).fact, "Queue W is not merged back yet: C:/p has uncommitted changes; the run of queue M, held at its step's end for this merge back, goes on");
  assert.match(mergeWaitNotice(q, "x", ["M", "N"]).fact, /; the runs of queues M, N, held at their step's end for this merge back, go on$/);
  const done = mergedNotice(q, { into: "main", sha: "0123456789abcdef" });
  assert.equal(done.fact, "Queue W is merged back: main moved forward to its integrated work (0123456), by a fast-forward. Nothing was pushed.");
});

test("the static analysis reminder: the notice, the command and the recommended additions in the orchestrator's briefing (queue MT)", async () => {
  const { orchestratorBriefing, staticAnalysisNotice } = await import("../src/prompts.ts");
  const orch = orchestratorBriefing("Pilot", 300_000);
  for (const part of [
    "nexus static-analysis decline --reason \"...\"",
    "A maintenance report ends with \"Recommended additions\" (not findings)",
  ]) assert.ok(orch.includes(part), `the orchestrator's briefing has ${JSON.stringify(part)}`);
  const n = staticAnalysisNotice();
  assert.match(n.fact, /^This project has no static analysis set up/);
  assert.match(n.todo, /^In one sentence, recommend the user the template static-analysis/);
  assert.match(n.todo, /nexus static-analysis decline --reason "<their words>" \(no reminder for 90 days\)/);
});

test("the orchestrator offers the lifecycle template once a queue that touched the run control or lifecycle code is done (queue TP)", async () => {
  const { orchestratorBriefing } = await import("../src/prompts.ts");
  const orch = orchestratorBriefing("Pilot", 300_000);
  assert.ok(orch.includes("When a queue that touched the project's run control or lifecycle code (its AGENTS.md may name which code that is) is done, offer the user in one sentence the lifecycle template (nexus template show lifecycle)"), orch);
});

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
  ProjectStore, addNote, answerAsUser, approveQueue, ensureUserSession, loadProjectState, newId, now, reportFile, sendMessage,
  type Event, type QueueFile, type SessionFile, type StepDef,
} from "@nexus/protocol";
import type { AgentEvents, AgentProcess, Priority } from "../src/agent.ts";
import type { Launch } from "../src/agent-host.ts";
import { Engine } from "../src/engine.ts";
import { freshSessionSeed, midStepSeed, noOutcomeNudge, stepOpening, switchReason } from "../src/prompts.ts";
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
  store.writeProject({ ...p, defaults: { ...p.defaults, stop_conditions: ["The project's own stop condition."], context_care: true, context_reuse_threshold: 0.6,
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
  store.writeProject({ ...p, defaults: { ...p.defaults, context_reuse_threshold: 0.55 } });
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
  const orch = orchestratorBriefing("Pilot", 60);
  for (const part of ["`nexus help review` (read it before you write a review.prepare)", "In review.prepare name the views with their keys and roles", "waiting-tab@492 before -> after"]) {
    assert.ok(orch.includes(part), `the orchestrator's briefing has ${JSON.stringify(part)}`);
  }
});

test("the three briefings say to run nexus and git commands on their own, and keep the line against working around a refusal (queue SH)", async () => {
  const { WORKER_BRIEFING, orchestratorBriefing, partnerBriefing } = await import("../src/prompts.ts");
  const alone = "Run nexus and git commands on their own, one per call, with nothing before the command name and no option before its subcommand: no cd, no &&, no pipes, not git -C <path> (they run in your working directory already). If one is refused, you may retry the same command once on its own (without chaining or -C), not in another shell.";
  const partner = partnerBriefing({ name: "P", root: "/p", languages: { working: "en" } } as unknown as Parameters<typeof partnerBriefing>[0], undefined);
  const briefings = { worker: WORKER_BRIEFING, orchestrator: orchestratorBriefing("Pilot", 60), partner };
  for (const [who, text] of Object.entries(briefings)) assert.equal(text.split(alone).length, 2, `the ${who}'s briefing says it once`);
  assert.ok(WORKER_BRIEFING.includes("- When an action is refused, do not work around it through another tool or command that reaches the same end (PowerShell after Bash, the shell after the edit tool); retry once in a simpler form at most (without chaining, for example), otherwise report what you needed and why.\n"));
  assert.ok(briefings.orchestrator.includes("\nWhen an action is refused, do not work around it through another tool or command that reaches the same end (PowerShell after Bash, for example); retry once in a simpler form at most, otherwise tell the user what you needed and why (`nexus help refusals`).\n"));
  assert.ok(partner.endsWith("\n- When an action is refused, do not work around it through another tool or command that reaches the same end; retry once in a simpler form at most, otherwise tell the user what you needed and why (`nexus help refusals`)."));
});

test("the orchestrator's briefing and notices on parallel worktrees and merging back (queue PW)", async () => {
  const { orchestratorBriefing, mergeWaitNotice, mergedNotice } = await import("../src/prompts.ts");
  const orch = orchestratorBriefing("Pilot", 60);
  for (const part of [
    "give a queue a worktree of its own (worktree: auto) when its work is independent",
    "queues that touch the same code run one after another (put them in the plan in order), never side by side",
    "id <queue>.integrate, review level 2",
    "it resolves a conflict only where the project's resolve_conflicts setting allows it",
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
  const orch = orchestratorBriefing("Pilot", 60);
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
  const orch = orchestratorBriefing("Pilot", 60);
  assert.ok(orch.includes("When a queue that touched the project's run control or lifecycle code (its AGENTS.md may name which code that is) is done, offer the user in one sentence the lifecycle template (nexus template show lifecycle)"), orch);
});

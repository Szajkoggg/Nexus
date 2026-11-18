// Nexus runs the queue's checks (DESIGN.md, "Nexus runs the checks"; PROTOCOL.md, "Checks run by Nexus"; queue EC,
// decided 2026-11-17 and 2026-11-18). After a worker's `nexus step done`, the engine runs the project's and the queue's
// checks itself, as one heavy operation of the workstation (src/capacity.ts), each a child process outside the event
// loop with its output in a log under the queue's folder, its state written to queues/<id>/checks.yaml before it
// starts and after it ends. A failing check runs once more in the same grant (passing then: flaky); failing twice, the
// worker gets a check-fix round with the failing tests, the end of the output and the log's path, up to
// `check_fix_limit` rounds, then the run halts for the orchestrator. A failure the worker says is not its work's is run
// on the queue's base commit, in a worktree of its own: failing there too, it is accepted (the step goes to review, and
// a fix queue is proposed); passing, it is the queue's; not runnable there, the orchestrator decides.
//
// The derivation (packages/protocol/src/checks.ts) reads the file: a step whose latest step.done's checks have not
// passed is `checking`, a fix round, or waiting for the orchestrator's decision. This module is the file's one writer.
import { execFile } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  applyDraft, checkSetOf, fillTemplate, lastDone, latestCheckSet, now, readTemplates, reviewRound, stepChecks,
  type CheckAttempt, type CheckDispute, type CheckRun, type CheckSet, type ChecksFile, type Event, type InboxEntry, type ProjectState,
  type ProjectStore, type QueueView, type RunFile, type StepView,
} from "@nexus/protocol";
import type { Capacity, Grant, HeavyProcess, Ticket } from "./capacity.ts";
import { checkoutOf, git } from "./gitinfo.ts";

/** A check running longer is ended and counts as failed (EC1's P10). */
const CHECK_LIMIT_MS = 60 * 60_000;
/** An update's drain waits this long for running checks, then ends them; they run again after the restart (P8). */
export const CHECK_DRAIN_WAIT_MS = 15 * 60_000;
/** What the worker gets of a failing check's output: its last lines, at most this many characters (P15). */
const TAIL_LINES = 80;
const TAIL_CHARS = 6000;

/**
 * The command runs through the system's shell (cmd.exe on Windows, sh elsewhere) as Node's `shell: true` runs it, in
 * a small Node launcher: the job host quotes each argument for CreateProcess, which cmd.exe's own switches do not
 * take, and the launcher's exit code is the command's.
 */
const LAUNCHER = 'const r=require("node:child_process").spawnSync(process.argv[1],{shell:true,stdio:"inherit",windowsHide:true});process.exit(r.status===null?1:r.status)';

/** A check's environment: the server's, without what makes a process a Nexus session or points at Nexus's own data. */
function checkEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["NEXUS_SESSION", "NEXUS_DIR", "NEXUS_HANDOVER", "NEXUS_HOME", "NODE_TEST_CONTEXT"]) delete env[k];
  return env;
}

/** The failing tests' names, where the output's format is known: node:test's spec reporter and TAP (P15). */
export function failedTests(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const spec = /^\s*✖ (.+?)(?: \(\d[\d.]*m?s\))?\s*$/.exec(line);
    if (spec && !/^failing tests:?$/.test(spec[1]!)) names.add(spec[1]!);
    const tap = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/.exec(line);
    if (tap) names.add(tap[1]!);
  }
  return [...names];
}

/** A command that cannot run where it was run (no such command or script), not a test that failed there. */
function unrunnable(code: number | null, output: string): boolean {
  return code === 127 || code === 9009 || /Missing script:|is not recognized as an internal or external command|command not found/i.test(output);
}

const tailOf = (text: string) => text.split(/\r?\n/).slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS).trim();
const slug = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "check";
const seconds = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10);
const run = promisify(execFile);
type StepDone = Extract<Event, { type: "step.done" }>;
type Disputed = Extract<Event, { type: "check.disputed" }>;
type Decided = Extract<Event, { type: "check.decided" }>;

/** What the engine does when checks end. */
export interface CheckHost {
  /** The project's id (the capacity coordinator's line). */
  project: string;
  /** Something changed: the engine looks at the run again. */
  ended(queue: string): void;
  /** The step's check-fix rounds are used up: the run halts for the orchestrator. */
  halt(queue: string, reason: string): void;
}

/** A queue's checks in hand: the request, then the grant and the process running; `lastBase`: a base run's result. */
interface Active { ticket: Ticket; grant?: Grant; proc?: HeavyProcess; stopped?: boolean; lastBase?: { attempt: CheckAttempt; output: string } }

export class CheckRunner {
  private readonly active = new Map<string, Active>();
  /** An update drains: nothing new starts (requests waiting for the machine are withdrawn). */
  private holding = false;
  private drainTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly limitMs: number;
  private readonly store: ProjectStore;
  private readonly capacity: Capacity;
  private readonly host: CheckHost;

  constructor(store: ProjectStore, capacity: Capacity, host: CheckHost, o: { limitMs?: number } = {}) {
    this.store = store;
    this.capacity = capacity;
    this.host = host;
    this.limitMs = o.limitMs ?? CHECK_LIMIT_MS;
    this.recover();
  }

  /** A step opened by this engine: Nexus runs its checks (fixed for the step, so an older step keeps the worker's). */
  opened(queue: string, step: string): void {
    const file = this.read(queue);
    if (file.steps[step]) return;
    file.steps[step] = { by: "nexus", sets: [] };
    this.write(queue, file);
  }

  /** Checks of this engine are running (granted, not only asked for): an update's drain waits for them. */
  running(): boolean {
    return [...this.active.values()].some((a) => a.grant);
  }

  /**
   * The engine's look at a step whose checks Nexus runs, at every advance. True: it is the checks' (running, waiting
   * for the machine or for the orchestrator's decision), and the engine does nothing else with the run now.
   */
  step(run: RunFile, q: QueueView, st: StepView, state: ProjectState): boolean {
    if (st.checks_by !== "nexus" || this.closed) return false;
    const done = lastDone(st);
    if (!done) return false;
    if (st.status === "checking") {
      if (this.active.has(q.id) || this.holding) return true;
      if (st.checking?.phase === "base") this.startBase(q, st, done, state);
      else this.startSet(run, q, st, done, state);
      return true;
    }
    if (st.status === "waiting" && st.checking?.phase === "decision") {
      this.decide(q, st, done, state);
      return true;
    }
    return false;
  }

  /**
   * A check-fix round waits to be delivered: its entry in the worker's inbox (written now for the extra round a
   * Resume gives after the limit). True when such an entry is there unread.
   */
  fixRound(q: QueueView, st: StepView, session: string, state: ProjectState): boolean {
    if (st.checks_by !== "nexus" || st.status !== "running" || !st.check_fix) return false;
    const set = latestCheckSet(q, st);
    if (!set || set.state !== "failed") return false;
    const inbox = state.sessions.find((x) => x.id === session)?.inbox ?? [];
    const ids = [`check-failed-${set.done}`, `check-failed-${set.done}-base`, `check-failed-${set.done}-decided`];
    if (!inbox.some((m) => ids.includes(m.id))) {
      // Past the limit, the run halted; a Resume (the orchestrator's or the user's) gives one more round.
      this.appendFix(session, q.id, st.id, set, `${failureText(this.store, q.id, set)}\nThe orchestrator gave one more round after the limit.`, `check-failed-${set.done}`);
      return true;
    }
    return inbox.some((m) => ids.includes(m.id) && !m.read_at);
  }

  /** Ends the queue's checks (Stop now, Stop at once): interrupted, they run again when the run goes on (P16). */
  stop(queue: string): void {
    const a = this.active.get(queue);
    if (!a) return;
    a.stopped = true;
    a.ticket.cancel();
    a.proc?.kill();
  }

  /** An update drains: nothing new starts; running checks get `waitMs`, then are ended (P8); 0: at once. */
  drain(waitMs: number): void {
    this.holding = true;
    for (const [queue, a] of this.active) if (!a.grant) this.stop(queue);
    clearTimeout(this.drainTimer);
    if (waitMs <= 0) { for (const q of this.active.keys()) this.stop(q); return; }
    this.drainTimer = setTimeout(() => { for (const q of this.active.keys()) this.stop(q); }, waitMs);
    this.drainTimer.unref();
  }

  /** The update did not happen: checks start again as their runs go on. */
  undrain(): void {
    this.holding = false;
    clearTimeout(this.drainTimer);
  }

  /** This engine stops: its checks end, nothing more is written (the next server runs them again). */
  shutdown(): void {
    this.closed = true;
    clearTimeout(this.drainTimer);
    for (const q of this.active.keys()) this.stop(q);
  }

  // ---------------------------------------------------------------- running a set

  private startSet(run: RunFile, q: QueueView, st: StepView, done: StepDone, state: ProjectState): void {
    const cwd = checkoutOf(this.store, q);
    const defs = stepChecks(run.checks, q.checks);
    const round = reviewRound(q, st, done.id) + 1;
    const file = this.read(q.id);
    const sets = file.steps[st.id]!.sets;
    const fix = sets.filter((s) => s.round === round && s.state === "failed" && s.done !== done.id).length;
    const head = cwd ? git(cwd, ["rev-parse", "HEAD"]) : undefined;
    const dirty = cwd ? !!git(cwd, ["status", "--porcelain", "--untracked-files=no"]) : false;
    const set: CheckSet = {
      done: done.id, round, fix, commit: head ?? null, ...(dirty ? { dirty } : {}), requested_at: now(), state: "queued",
      checks: defs.map((name) => ({ name, command: name, runs: [] })),
    };
    const i = sets.findIndex((s) => s.done === done.id);
    if (i >= 0) sets[i] = set; else sets.push(set);
    this.write(q.id, file);
    if (!defs.length || !cwd) { this.finishSet(q.id, st.id, done.id, state, []); this.host.ended(q.id); return; }
    const a = this.ask(q.id, st.id);
    a.ticket.granted.then((grant) => this.runSet(a, grant, q.id, st.id, done.id, cwd, state), () => {
      this.active.delete(q.id);
      this.update(q.id, st.id, done.id, (s) => { s.state = "interrupted"; });
    });
  }

  private async runSet(a: Active, grant: Grant, queue: string, step: string, done: string, cwd: string, state: ProjectState): Promise<void> {
    a.grant = grant;
    try {
      if (a.stopped) return;
      this.update(queue, step, done, (s) => { s.state = "running"; s.granted_at = now(); });
      this.host.ended(queue);
      const set = checkSetOf(this.read(queue), step, done)!;
      const failed: string[] = [];
      for (const [i, c] of set.checks.entries()) {
        if (a.stopped) break;
        if (!(await this.attempt(a, grant, queue, step, done, c, i, cwd, 1))) failed.push(c.name);
      }
      // Each failed check once more, in the same grant: the code has not changed (P3).
      const twice: string[] = [];
      for (const name of failed) {
        if (a.stopped) break;
        const i = set.checks.findIndex((c) => c.name === name);
        if (!(await this.attempt(a, grant, queue, step, done, set.checks[i]!, i, cwd, 2))) twice.push(name);
      }
      if (a.stopped) {
        this.update(queue, step, done, (s) => { s.state = "interrupted"; s.ended_at = now(); });
        return;
      }
      this.finishSet(queue, step, done, state, twice);
    } finally {
      this.release(grant, queue);
    }
  }

  /** One run of a check; whether it passed. Its state is written before it starts and after its tree has ended. */
  private async attempt(a: Active, grant: Grant, queue: string, step: string, done: string, c: CheckRun, index: number, cwd: string, n: number, base = false): Promise<boolean> {
    const set = checkSetOf(this.read(queue), step, done)!;
    const rel = `checks/${step}/r${set.round}f${set.fix}-${index + 1}-${slug(c.name)}${base ? "-base" : ""}.${n}.log`;
    const attempt: CheckAttempt = { started_at: now(), log: rel };
    if (!base) this.update(queue, step, done, (s) => { s.checks[index]!.runs.push(attempt); });
    const result = await this.execute(a, grant, c.command, cwd, join(this.store.queueDir(queue), rel));
    const ended: CheckAttempt = {
      ...attempt, ended_at: now(), duration: seconds(attempt.started_at, now()), exit_code: result.code,
      ...(result.timedOut ? { timed_out: true } : {}), ...(a.stopped ? { interrupted: true } : {}),
      ...(result.ok ? {} : { tail: tailOf(result.output), failed_tests: failedTests(result.output) }),
    };
    if (base) { a.lastBase = { attempt: ended, output: result.output }; return result.ok; }
    this.update(queue, step, done, (s) => {
      const run = s.checks[index]!;
      run.runs[run.runs.length - 1] = ended;
      if (a.stopped) return;
      if (result.ok) { run.ok = true; if (n > 1) run.flaky = true; }
      else if (n > 1) run.ok = false;
    });
    return result.ok;
  }

  /** Runs `command` under the grant in `cwd`, its output to `log`; the root's exit code, once its tree has ended. */
  private async execute(a: Active, grant: Grant, command: string, cwd: string, log: string): Promise<{ ok: boolean; code: number | null; output: string; timedOut: boolean }> {
    mkdirSync(join(log, ".."), { recursive: true });
    const out = createWriteStream(log);
    let tail = "";
    const keep = (d: Buffer) => { out.write(d); tail = (tail + d.toString("utf8")).slice(-TAIL_CHARS * 4); };
    const p = grant.spawn(process.execPath, ["-e", LAUNCHER, command], { cwd, env: checkEnv() });
    a.proc = p;
    // The output may still be on its way when the tree has ended: the log closes once both streams have.
    const drained = (s: NodeJS.ReadableStream) => new Promise<void>((r) => { s.once("end", () => r()); s.once("close", () => r()); s.once("error", () => r()); });
    const streams = Promise.all([drained(p.child.stdout), drained(p.child.stderr)]);
    p.child.stdout.on("data", keep);
    p.child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, this.limitMs);
    const code = await p.done;
    await Promise.race([streams, new Promise((r) => setTimeout(r, 2000))]);
    clearTimeout(timer);
    a.proc = undefined;
    await new Promise<void>((r) => out.end(() => r()));
    const ok = code === 0 && !timedOut && !a.stopped;
    return { ok, code: timedOut || a.stopped ? null : code, output: tail, timedOut };
  }

  /** The set's outcome: passed (to review), or a fix round, or the limit (the run halts). */
  private finishSet(queue: string, step: string, done: string, state: ProjectState, failed: string[]): void {
    const limit = state.project.defaults.check_fix_limit;
    let halt: string | undefined;
    this.update(queue, step, done, (s) => {
      s.ended_at = now();
      if (!failed.length) { s.state = "passed"; return; }
      s.state = "failed";
      if (s.fix >= limit) { s.limit = true; halt = `step ${step}: the checks failed after ${s.fix} check-fix round${s.fix === 1 ? "" : "s"} (the limit, check_fix_limit ${limit}): ${failed.join(", ")}`; }
    });
    const set = checkSetOf(this.read(queue), step, done)!;
    if (halt) { this.host.halt(queue, halt); return; }
    if (set.state === "failed") {
      const session = this.session(state, queue, step);
      if (session) this.appendFix(session, queue, step, set, failureText(this.store, queue, set), `check-failed-${done}`);
    }
  }

  // ---------------------------------------------------------------- a disputed failure

  private startBase(q: QueueView, st: StepView, done: StepDone, state: ProjectState): void {
    const set = checkSetOf(q.check_runs, st.id, done.id);
    const ev = st.timeline.findLast((e): e is Disputed => e.type === "check.disputed" && e.at >= done.at);
    if (!set || !ev) return;
    if (!set.dispute) this.update(q.id, st.id, done.id, (s) => { s.dispute = { event: ev.id, name: ev.name, evidence: ev.evidence, at: ev.at, base: { state: "queued" } }; });
    const check = set.checks.find((c) => c.name === (set.dispute?.name ?? ev.name));
    const cwd = checkoutOf(this.store, q);
    const base = baseCommit(this.store, q);
    if (!check || check.ok !== false) return this.endBase(q.id, st.id, done.id, state, "unrunnable", `${ev.name} is not one of the checks that failed`);
    if (!cwd || !base) return this.endBase(q.id, st.id, done.id, state, "unrunnable", "no base commit of the queue is known");
    const a = this.ask(q.id, st.id);
    a.ticket.granted.then((grant) => this.runBase(a, grant, q.id, st.id, done.id, check, set.checks.indexOf(check), cwd, base, state), () => {
      this.active.delete(q.id); // withdrawn (a drain, a stop): asked again when the run goes on
    });
  }

  /** The disputed check on the queue's base commit, in a worktree of its own, with the project's setup (P6). */
  private async runBase(a: Active, grant: Grant, queue: string, step: string, done: string, check: CheckRun, index: number, cwd: string, base: string, state: ProjectState): Promise<void> {
    a.grant = grant;
    const dir = mkdtempSync(join(tmpdir(), "nexus-base-"));
    let added = false;
    try {
      if (a.stopped) return;
      this.update(queue, step, done, (s) => { s.dispute!.base = { state: "running", commit: base }; });
      this.host.ended(queue);
      try { await run("git", ["worktree", "add", "--detach", dir, base], { cwd, windowsHide: true }); added = true; }
      catch (e) { return this.endBase(queue, step, done, state, "unrunnable", `git worktree add of ${base} failed: ${String((e as Error).message).split("\n")[0]}`); }
      const setup = state.project.defaults.worktree_setup?.trim();
      if (setup) {
        const r = await this.execute(a, grant, setup, dir, join(this.store.queueDir(queue), `checks/${step}/base-setup.log`));
        if (a.stopped) return;
        if (!r.ok) return this.endBase(queue, step, done, state, "unrunnable", `the worktree setup (${setup}) failed: ${r.timedOut ? "it ran too long" : `exit code ${r.code}`}`);
      }
      const ok = await this.attempt(a, grant, queue, step, done, check, index, dir, 1, true);
      if (a.stopped) return;
      const last = a.lastBase!;
      if (ok) return this.endBase(queue, step, done, state, "passed", undefined, last.attempt);
      if (unrunnable(last.attempt.exit_code ?? null, last.output)) return this.endBase(queue, step, done, state, "unrunnable", `it cannot run there (exit code ${last.attempt.exit_code})`, last.attempt);
      this.endBase(queue, step, done, state, "failed", undefined, last.attempt);
    } finally {
      if (a.stopped && !this.closed) this.update(queue, step, done, (s) => { if (s.dispute?.base?.state === "running") s.dispute.base = { state: "queued" }; });
      if (added) await run("git", ["worktree", "remove", "--force", dir], { cwd, windowsHide: true }).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      this.release(grant, queue);
    }
  }

  private endBase(queue: string, step: string, done: string, state: ProjectState, result: "passed" | "failed" | "unrunnable", reason?: string, attempt?: CheckAttempt): void {
    const commit = baseCommit(this.store, state.queues.find((x) => x.id === queue)!) ?? undefined;
    this.update(queue, step, done, (s) => {
      s.dispute!.base = { state: result, ...(commit ? { commit } : {}), ...(reason ? { reason } : {}), ...(attempt ? { run: attempt } : {}) };
      if (result === "passed") s.dispute!.outcome = "fix";
    });
    if (result === "failed") return this.accept(queue, step, done, state);
    if (result === "passed") {
      const set = checkSetOf(this.read(queue), step, done)!;
      const session = this.session(state, queue, step);
      if (session) this.appendFix(session, queue, step, set, `The check ${set.dispute!.name} passes on the queue's base commit ${commit ?? "?"}: the failure comes with this queue's work, so it is yours to fix in this round.\n${failureText(this.store, queue, set)}`, `check-failed-${done}-base`);
    }
    this.host.ended(queue);
  }

  /** The orchestrator's decision on a disputed failure that could not be run on the base (`nexus check decide`). */
  private decide(q: QueueView, st: StepView, done: StepDone, state: ProjectState): void {
    const set = checkSetOf(q.check_runs, st.id, done.id);
    const d = set?.dispute;
    if (!set || !d || d.decided) return;
    const ev = st.timeline.findLast((e): e is Decided => e.type === "check.decided" && e.at >= d.at);
    if (!ev) return;
    this.update(q.id, st.id, done.id, (s) => {
      s.dispute!.decided = { verdict: ev.verdict, reason: ev.reason, at: ev.at, event: ev.id };
      if (ev.verdict === "fix") s.dispute!.outcome = "fix";
    });
    if (ev.verdict === "accept") return this.accept(q.id, st.id, done.id, state);
    const session = this.session(state, q.id, st.id);
    if (session) this.appendFix(session, q.id, st.id, set, `The orchestrator decided the failure of ${d.name} is the queue's to fix: ${ev.reason}\n${failureText(this.store, q.id, set)}`, `check-failed-${done.id}-decided`);
    this.host.ended(q.id);
  }

  /** An accepted failure: the step goes to review, and a fix queue is proposed for it (or the open one gets it). */
  private accept(queue: string, step: string, done: string, state: ProjectState): void {
    // The fix queue first, so the orchestrator, told of the accepted failure, is told of its queue in the same notice.
    const set = checkSetOf(this.read(queue), step, done)!;
    let fixQueue: CheckSet["fix_queue"];
    try { fixQueue = proposeFixQueue(this.store, state, queue, step, set); }
    catch (e) { console.error(`queue ${queue} step ${step}: the fix queue for the accepted failure was not proposed: ${(e as Error).message}`); }
    this.update(queue, step, done, (s) => { s.state = "accepted"; s.dispute!.outcome = "accepted"; if (fixQueue) s.fix_queue = fixQueue; });
    this.host.ended(queue);
  }

  // ---------------------------------------------------------------- the machine

  /** Asks the capacity coordinator for the queue's checks; the engine looks again (the step waits for the machine). */
  private ask(queue: string, step: string): Active {
    const a: Active = { ticket: this.capacity.request({ kind: "checks", project: this.host.project, queue, step }) };
    this.active.set(queue, a);
    this.host.ended(queue);
    return a;
  }

  /** The checks' grant is over: the slot goes once its processes have ended, and the engine looks at the run again. */
  private release(grant: Grant, queue: string): void {
    grant.end();
    this.active.delete(queue);
    if (!this.closed) this.host.ended(queue);
  }

  // ---------------------------------------------------------------- the file

  private read(queue: string): ChecksFile {
    return this.store.readChecks(queue) ?? { protocol: 1, steps: {} };
  }

  private write(queue: string, file: ChecksFile): void {
    if (!this.closed) this.store.writeChecks(queue, file);
  }

  private update(queue: string, step: string, done: string, change: (s: CheckSet) => void): void {
    if (this.closed) return;
    const file = this.read(queue);
    const set = file.steps[step]?.sets.find((s) => s.done === done);
    if (!set) return;
    change(set);
    this.write(queue, file);
  }

  private session(state: ProjectState, queue: string, step: string): string | undefined {
    const q = state.queues.find((x) => x.id === queue);
    return q?.steps.find((s) => s.id === step)?.session ?? q?.run?.session;
  }

  private appendFix(session: string, queue: string, step: string, set: CheckSet, text: string, id: string): void {
    const entry: InboxEntry = { v: 1, id, at: now(), from: "nexus", type: "check_failed", ref: set.done, queue, step, fix: set.fix + 1, text };
    this.store.appendInbox(session, entry);
  }

  /**
   * A starting engine: what the old server left running or waiting ended with it. Its sets are interrupted, and run
   * again, from the start, when their runs go on; a base run is asked for again.
   */
  private recover(): void {
    for (const queue of this.store.queueIds()) {
      let file: ChecksFile | undefined;
      try { file = this.store.readChecks(queue); } catch { continue; }
      if (!file) continue;
      let changed = false;
      for (const entry of Object.values(file.steps)) for (const s of entry.sets) {
        if (s.state === "queued" || s.state === "running") { s.state = "interrupted"; changed = true; }
        for (const c of s.checks) for (const r of c.runs) if (!r.ended_at) { r.ended_at = now(); r.interrupted = true; changed = true; }
        if (s.dispute?.base?.state === "running") { s.dispute.base = { state: "queued" }; changed = true; }
      }
      if (changed) this.write(queue, file);
    }
  }
}

/**
 * The queue's base commit, where a disputed check runs (P6): the commit its worktree was made from, else the HEAD of
 * its checkout when its first step opened.
 */
function baseCommit(store: ProjectStore, q: Pick<QueueView, "id">): string | undefined {
  const g = store.readGit(q.id);
  if (g?.base?.sha) return g.base.sha;
  const starts = Object.values(g?.steps ?? {}).flatMap((rounds) => rounds.filter((r) => r.start).map((r) => ({ sha: r.start!, at: r.started_at })));
  return starts.sort((a, b) => a.at.localeCompare(b.at))[0]?.sha;
}

/** What failed, for the worker: each check's failing tests, the end of its output and its log's full path. */
function failureText(store: ProjectStore, queue: string, set: CheckSet): string {
  const failed = set.checks.filter((c) => c.ok === false);
  return failed.map((c) => {
    const last = c.runs.at(-1)!;
    return [
      `Check "${c.name}" failed twice${last.timed_out ? " (ended at its time limit)" : ` (exit code ${last.exit_code ?? "none"})`}.`,
      last.failed_tests?.length ? `Failing tests:\n${last.failed_tests.map((t) => `- ${t}`).join("\n")}` : "",
      `Full log: ${join(store.queueDir(queue), last.log)}`,
      last.tail ? `The end of its output:\n${last.tail}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

/**
 * The fix queue of an accepted failure (the user's decision of 2026-11-18): proposed at once, from the check-failure
 * template (origin ci), with the failure's data; when an open one (not done or cancelled) is there for the same tests,
 * the occurrence is added to its description instead. The orchestrator is told (src/orchestrator.ts).
 */
function proposeFixQueue(store: ProjectStore, state: ProjectState, queue: string, step: string, set: CheckSet): { id: string; created: boolean } {
  const d = set.dispute as CheckDispute;
  const check = set.checks.find((c) => c.name === d.name)!;
  const last = check.runs.at(-1)!;
  const keys = last.failed_tests?.length ? last.failed_tests.map((t) => `- test: ${t}`) : [`- check: ${check.name}`];
  const how = d.decided?.verdict === "accept" ? `accepted by the orchestrator: ${d.decided.reason}` : `fails on the base commit ${d.base?.commit ?? "?"} too`;
  const occurrence = `- ${now()}: queue ${queue}, step ${step} (round ${set.round}, check-fix round ${set.fix + 1}), commit ${set.commit ?? "?"}; ${how}. Log: ${join(store.queueDir(queue), last.log)}. The worker's evidence: ${d.evidence}${last.tail ? `\n  The end of its output: ${last.tail.split("\n").slice(-5).join(" | ")}` : ""}`;
  const open = state.queues.find((x) => x.origin === "ci" && x.status !== "done" && x.status !== "cancelled" && keys.some((k) => (x.description ?? "").split("\n").includes(k)));
  if (open) {
    const q = store.readQueue(open.id);
    store.writeQueue({ ...q, description: `${(q.description ?? "").trimEnd()}\n${occurrence}\n` });
    return { id: open.id, created: false };
  }
  const t = readTemplates(state.project.root).templates.find((x) => x.id === "check-failure");
  if (!t) throw new Error("the check-failure template is missing");
  const taken = new Set(store.queueIds());
  let id = "CI";
  for (let n = 2; taken.has(id); n++) id = `CI${n}`;
  applyDraft(store, fillTemplate(t, { check: check.name, tests: keys.join("\n"), occurrence }, id));
  return { id, created: true };
}


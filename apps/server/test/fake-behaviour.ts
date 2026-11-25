// What the fake runtimes (fake-claude.ts, fake-codex.ts) do with a message. A step turn's goal says
// "FAKE: <behaviour>":
//   done   report the step done              ask     ask a blocking question, then end the turn
//   noop   end the turn without an outcome   stop    report a stop condition
//   fail   report the step failed            slow    work (work() below: FAKE_SLOW_MS or held by the test), then done
//   stop1  report a stop condition the first time, done once the stop is lifted
//   ask1   ask a blocking question the first time (a step turn of this step in any session counts), done after;
//          with FAKE_ASK_LINGER_MS, the asking turn ends that long after the question (a test that answers or writes
//          before the turn is over then fails every time, not only under load)
//   partial  the first time: a progress line, a commit of <step>-a.txt, then <step>-a.txt changed and <step>-b.txt
//            written without a commit, and the turn ends without an outcome; after: done if <step>-b.txt is still
//            there ("kept the uncommitted work"), else failed
//   slownoop  work, then end the turn without an outcome (the step stays open)
//   slowask   work, then ask a blocking question and end the turn
//   askslow   ask a blocking question and end the turn; the answer's turn works (work() below) before it reports the
//             step done, so a test sees the queue at work after its answer (queue FL1)
//   askwork   ask a question with --can-continue, work on (work() below) in the same turn, then end it without an
//             outcome; the answer's turn reports the step done
//   doneexit  report the step done, then the process exits on a signal before its turn ends
//   doneexitheld  the same, held by FAKE_RELEASE before exit so a test can accept review first
//   commit    commit a file named after the step in its working directory, then done
//   commitstop  the same commit, then a stop condition
//   untracked   write <step>-left.txt in its working directory, neither added nor committed, then done
//   background  start work in the background (a command) and end the turn without an outcome; the work ends when the
//               file FAKE_BG_RELEASE names exists (the test lets it end once Nexus has taken the turn's end in), else
//               after FAKE_BG_MS (default 1500). Claude's fake then starts a turn by itself with the task's notification,
//               as Claude Code does; Codex's does not (Nexus nudges). Told of the end either way, it reports done.
//   bgagent     the same with a sub-agent in the background
//   bglong      the same command, running FAKE_BG_LONG_MS (default 600000): past the engine's limit in a test
//   subagent    run a sub-agent in the foreground within the turn (Claude's fake reports its tokens apart: 2 input, 1
//               output, 500 cache-creation, as Claude Code does in modelUsage only), then done
//   metric      record each "FAKE-METRIC: <name> <value>" line of the goal with nexus metric record, then done
//   review      write a picture and a note into <temp>/nexus-review/<step>/ (outside the working tree), add them with
//               nexus review add (the picture keyed, as a result), then done
//   checks      report each check its opening lists under "Checks for every step" with nexus check, under that exact
//               name, as the opening asks, then done
//   shortchecks the same under a short name of its own (the last word: "npm test" as "test"), as workers once did;
//               nexus check refuses those names now (queue ACX, W4), so nothing is recorded
//   ownedhold   hold an empty directory with a Windows helper until worker cleanup; work(), then done
//   owneddeny   the same, but the helper denies PROCESS_TERMINATE on its own process DACL
//   noopexit1   Codex's fake only: the first time (counted beside FAKE_LOG, any process of the step), end the turn
//               without an outcome, then exit with its stdout held open (exitHeld below); after: done
// The closing refactoring step's standard goal has no "FAKE:": it does FAKE_CLOSING's behaviour, by default done, with a
// summary that finds nothing worth refactoring (the valid outcome of a small change).
// The integration step's has none either: it does FAKE_INTEGRATE's behaviour, by default "merge": it runs the merge its
// opening names (git merge --no-edit <base>); on a conflict it resolves it (each conflicting file as the queue's branch
// has it) only when the opening allows it and the file FAKE_INTEGRATE_GIVE_UP names does not exist (a file, so a test
// changes it under a running process), else it aborts the merge and stops with the condition the opening gives. Done, it reports the resulting HEAD (and writes the report, as the last step).
// A failure of the runtime, then done: "<kind><n>" fails the step's first n turns (counted in a file beside
// FAKE_LOG, so a new process goes on counting), "<kind>" every turn. Kinds: overloaded, network (passing), auth
// (lasting), limit (a usage limit resetting FAKE_RESET_MS, default 1500, later), crash (the process exits mid-turn),
// cloudflare (an HTTP 403 page from Cloudflare, which the runtimes report as an authentication failure: passing).
// Each fake writes the failure the way its runtime does (fake-claude.ts, fake-codex.ts).
// "refused": the agent tries actions that are refused (each fake writes them as its runtime does), then done.
// "summary": done, then the step's context summary (`nexus context`); "summaryslow": the same, then it works (as
// "slow") before the turn ends. Nexus asking for the summary ("[Nexus] … write your context summary") gets one, unless
// FAKE_NO_SUMMARY is set (with FAKE_SUMMARY_FAIL set, that turn fails as the failure kind it names); so does the orchestrator ("[Nexus] Your context holds …"), with "fake orchestrator
// summary" (topics plan, promises; file docs/plan.md), and with FAKE_SUMMARY_MS set it then works that long. FAKE_CONTEXT_FILL (0 to 1) is the context fill each turn reports
// (default: claude 10 %, codex 6 %) of the context window, FAKE_CONTEXT_WINDOW tokens (default: claude 1000, codex 2000); FAKE_CONTEXT_FILL_FILE names a file whose content, while it exists, replaces it (a
// test changes the fill of a running process). A step turn may come after a seed (context care's first prompt of a fresh session): it is found at the
// start of any line.
// An answer ("[Nexus] Answer …") makes it report the current step done (also in a new process of the session: the
// step is kept in a file beside FAKE_LOG). As an orchestrator: "FAKE-DRAFT:" followed by
// YAML drafts that queue; "FAKE-NEXUS: [args]" runs `nexus` with those arguments; "FAKE-SCRIPT: <file>" runs that
// file with Node inside the agent's process tree (its job on Windows) and replies with its output; a "[Nexus] A worker
// asked … (qid X;" notice is answered with "fake answer"; with FAKE_REVIEW_ACCEPT set, a notice of a step waiting for its review is
// answered with `nexus review accept`. "FAKE-LONG" is answered with longReply("Reply"); a hand-over with
// longReply("SUMMARY"). "FAKE-SLOW" in a chat message (with FAKE_CHAT_SLOW_ALL set, any chat message not steered
// otherwise: a capture's reply in progress): the turn works for FAKE_CHAT_SLOW_MS (default 4000), then replies
// "slow reply"; a stop (interrupt) ends it early. "FAKE-HOLD": waits for FAKE_RELEASE (as a slow worker does),
// so a test can change usage during a chat turn. "FAKE-EXIT-HELD" (Codex's fake only): replies "exit reply", then
// exits with its stdout held open (exitHeld below). "FAKE-HISTORY": the reply lists every message the agent took in so
// far ("history: a | b"): the turns' messages and those read inside a turn (Claude's `next`, Codex's steer).
// As a review helper (its packet: "[Nexus] Review step S of queue Q, round R"), the step's goal steers it with
// "FAKE-HELPER: <verdict>": accept (nexus review accept), sendback (nexus review send-back, every round), sendback1
// (the first round only, accept after), passon:<reasons> (nexus review pass-on --why <reasons>), none (no verdict),
// hang (no verdict, held by FAKE_RELEASE like a slow step), refused (an action its permissions refuse, then nexus ask,
// which the CLI refuses a helper, then a pass-on with doubt naming both). Without one: accept at level 2, pass on
// (level) at level 3. Each verdict's text starts "fake helper".
// Claude's fake keeps the conversations it saved (fakeSaved below) and refuses, as Claude Code does, to resume one it
// never saved or to start a saved one anew; FAKE_START_MS: it reads its input only after that long (Claude Code's
// start-up), so a test can end it before it saved anything; FAKE_REFUSE: it refuses every start, each in its way;
// FAKE_LATE_NEXT: its first turn's result waits for a message sent after its reply, which then runs as a turn of its own
// (once the file FAKE_LATE_GATE names exists, when set; the process runs it before it exits, its input closed or not);
// FAKE_LATE_NEXT=inside: that message is read inside the turn, and no turn of its own follows.
// FAKE_GATES (Claude's fake, in the test's own process): holds it at the points a FakeGates set arms (first-read, save,
// first-output, refusal, stderr, exit) until the test releases each arrival; the set's env() goes into the adapter's
// options, never into process.env. "FAKE-EXIT: <code | signal> [<stderr text>]" as a message (Claude's fake): the process
// ends that way as it takes the message in, writing the text to stderr first; before any output if it is the first.
// FAKE_CODEX_RPC (Codex's fake): a JSON object of method to what it does instead of its answer: {"error": {code,
// message}}, {"result": ...} (a malformed answer), "silent" (no answer), {"exit": <code | "signal">}, "pass"; one
// action for every request of the method, or a list, one per request (its own answers after the list). Its turn/start
// in a thread it did not start or resume fails ("thread not found"), as Codex's does.
import { errorText } from "@nexus/protocol/errors";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * What a fake runtime has in place of its process's (queue IPR): run as a script (fake-claude.ts, fake-codex.ts as a
 * process), these are process.argv, process.env, process.stdin and so on; run in the test's own process
 * (in-process-runtime.ts), its own streams, environment and working directory, as the adapter gave them to the child.
 */
export interface FakeIo {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Ends the runtime with this exit code, as its process's exit would. */
  exit(code: number): void;
  /** Ends the runtime as a signal would (SIGTERM; on Windows exit code 1). */
  signal(): void;
}

/**
 * Runs a fake on this process's own stdio when its file (`moduleUrl`, its import.meta.url) was started as a script:
 * the fake as a process of its own, for the tests of real processes.
 */
export function runAsScript(moduleUrl: string, run: (io: FakeIo) => unknown): void {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
  run({
    argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    exit: (code) => process.exit(code), signal: () => process.kill(process.pid, "SIGTERM"),
  });
}

/** A promise that never settles: what an ended fake's work waits on, as a process's work ends with it. */
const never = <T = never>(): Promise<T> => new Promise<T>(() => {});

/**
 * Calls `fn` after `ms`, unless the fake has ended by then: an ended fake's timers are cleared (endFake), as its
 * process's would be with it.
 */
export function later(fake: Fake, fn: () => void, ms: number): void {
  if (fake.ended) return;
  const timers = (fake.timers ??= new Set());
  const t = setTimeout(() => { timers.delete(t); if (!fake.ended) fn(); }, ms);
  timers.add(t);
}

/**
 * The points where a test can hold a fake (FakeGates, queue LCR): Claude's fake at its start-up and its end.
 * - first-read  before the process reads its input at all (Claude Code starting up)
 * - save        a fresh session's conversation was just saved, as its first message is read; nothing of the turn yet
 *               (a resumed session saves nothing, so never arrives here)
 * - first-output  before the process's first line on stdout (held with every line after it until released)
 * - refusal     a start the CLI refuses, before it writes anything of the refusal (detail: the refusal's text)
 * - stderr      before the process writes to stderr (detail: the text)
 * - exit        before the process exits (detail: the exit code, or "signal"); after what it wrote to stdout
 * Codex's fake: "answer:<method>", before it handles a request of that method (its answer and every line after it
 * wait; detail: the method).
 */
export type FakePoint = "first-read" | "save" | "first-output" | "refusal" | "stderr" | "exit" | `answer:${string}`;

/** A fake held at a point: what the test waited for (FakeGates.reached). */
export interface FakeHeld {
  readonly point: FakePoint;
  readonly detail?: string;
  /** Which of the gates' fakes it is: 1 for the first process started with them, 2 for the next (a retried start). */
  readonly process: number;
  /** Lets the fake go on from the point; a fake ended meanwhile (killed) stays ended. */
  release(): void;
}

/** The gate sets of this process by id: FAKE_GATES in a fake's environment names one. */
const gateSets = new Map<string, FakeGates>();
let gateSetCount = 0;

/** How many gate sets are registered (not disposed): a test checks it returns to what it was. */
export const fakeGateSets = (): number => gateSets.size;

/**
 * Holds the fakes started with its environment (env(), in the adapter's options, never process.env) at the points it
 * arms, each arrival until the test releases it: the test waits for an arrival (reached), looks at what Nexus did, and
 * lets the fake go on. No timer and no file: it works for the fakes in the test's own process only (in-process-runtime.ts);
 * a fake whose FAKE_GATES names no registered set (a fake as a process of its own, or after dispose) fails at its start.
 */
export class FakeGates {
  readonly id: string;
  private readonly armed: ReadonlySet<FakePoint>;
  private readonly arrivals: FakeHeld[] = [];
  private readonly waiters: { point: FakePoint; resolve: (h: FakeHeld) => void }[] = [];
  private readonly fakes: Fake[] = [];
  private readonly unreleased = new Set<FakeHeld>();

  constructor(points: readonly FakePoint[]) {
    this.id = `gates-${process.pid}-${++gateSetCount}`;
    this.armed = new Set(points);
    gateSets.set(this.id, this);
  }

  /** The environment that puts a fake under these gates: for the adapter's options (ClaudeOptions.env). */
  env(): Record<string, string> { return { FAKE_GATES: this.id }; }

  /** The next arrival at `point` not waited for yet, once a fake is there. */
  reached(point: FakePoint): Promise<FakeHeld> {
    const i = this.arrivals.findIndex((a) => a.point === point);
    if (i >= 0) return Promise.resolve(this.arrivals.splice(i, 1)[0]!);
    return new Promise((resolve) => this.waiters.push({ point, resolve }));
  }

  /** A fake started with these gates (its process number). */
  join(fake: Fake): number { this.fakes.push(fake); return this.fakes.length; }

  /** Holds the fake at `point` if it is armed: `go` runs once the test releases it (at once if not armed). */
  pass(fake: Fake, point: FakePoint, process: number, go: () => void, detail?: string): void {
    if (!this.armed.has(point)) { go(); return; }
    let done = false;
    const held: FakeHeld = {
      point, detail, process,
      release: () => { if (done) return; done = true; this.unreleased.delete(held); if (!fake.ended) go(); },
    };
    this.unreleased.add(held);
    const w = this.waiters.findIndex((x) => x.point === point);
    if (w >= 0) this.waiters.splice(w, 1)[0]!.resolve(held); else this.arrivals.push(held);
  }

  /**
   * What the gates leave behind: arrivals neither released nor of an ended fake, fakes still running, ended fakes with a
   * timer left. A test that ended its sessions expects all empty.
   */
  leftovers(): { held: string[]; running: number; timers: number } {
    return {
      held: [...this.unreleased].filter((h) => !this.fakes[h.process - 1]?.ended).map((h) => `${h.point}#${h.process}`),
      running: this.fakes.filter((f) => !f.ended).length,
      timers: this.fakes.reduce((n, f) => n + (f.timers?.size ?? 0), 0),
    };
  }

  /** Unregisters the set: a fake started with it after this fails at its start. */
  dispose(): void { gateSets.delete(this.id); }
}

/** The gates a fake's environment names (FAKE_GATES), if any; a name not registered in this process is an error. */
export function fakeGatesOf(env: NodeJS.ProcessEnv): FakeGates | undefined {
  const id = env.FAKE_GATES;
  if (!id) return undefined;
  const set = gateSets.get(id);
  if (!set) throw new Error(`FAKE_GATES names ${id}, which is not registered in this process: gates hold only the fakes run in the test's own process, until the set is disposed`);
  return set;
}

/** Waits `ms`; never resolves for a fake ended meanwhile. */
const sleep = (fake: Fake, ms: number): Promise<void> => new Promise((r) => later(fake, r, ms));

/** Ends the fake: no more output, no timer fires, no `nexus` call starts (a process killed or exited). */
export function endFake(fake: Fake): void {
  fake.ended = true;
  for (const t of fake.timers ?? []) clearTimeout(t);
  fake.timers?.clear();
}

/**
 * `nexus`, run inside the fake with its environment and working directory (queue IPR): the CLI's run(), loaded at the
 * first call. A failure throws, as a failed process did. The fake's input waits meanwhile, as it did while the fake
 * waited for the process: a message sent during a call (one that waits for the server, `queue draft`) is read after
 * it, not taken in as read inside the turn. An ended fake starts none.
 */
const cli = () => import("../../../packages/cli/test/run-cli.ts");
async function holdingInput<T>(fake: Fake, call: () => Promise<T>): Promise<T> {
  if (fake.ended) return never();
  const stdin = fake.io.stdin;
  const hold = !stdin.isPaused();
  if (hold) stdin.pause();
  try { return await call(); } finally { if (hold) stdin.resume(); }
}
const callNexus = async (fake: Fake, args: string[]): Promise<void> => {
  await holdingInput(fake, async () => (await cli()).cliOut(args, { env: fake.io.env, cwd: fake.io.cwd }));
};
const callNexusOut = async (fake: Fake, args: string[], input?: string): Promise<string> => {
  const r = await holdingInput(fake, async () => (await cli()).cliRun(args, { env: fake.io.env, cwd: fake.io.cwd, input }));
  return r.status === 0 ? r.stdout.trim() : `nexus failed: ${r.stderr.trim()}`;
};

/**
 * Appends a line to a log the tests read while the fakes write it. appendFileSync creates a new file and writes to it
 * in two calls, and a test that saw the file exist could read it empty in between (queue KM: "Unexpected end of JSON
 * input" in two full runs). So a new file comes into place with its first line in it (written beside it, then linked
 * there); when another process made it meanwhile, the line is appended as usual.
 */
function appendLine(file: string, line: string): void {
  if (!existsSync(file)) {
    const part = `${file}.${process.pid}.part`;
    writeFileSync(part, line);
    try { linkSync(part, file); return; } catch { /* made meanwhile: append */ } finally { unlinkSync(part); }
  }
  appendFileSync(file, line);
}

/** Records what reached the agent and how, for the tests (FAKE_LOG, one JSON line each). */
export function record(fake: Fake, text: string, priority: string | null, busy: boolean): void {
  const env = fake.io.env;
  if (env.FAKE_LOG) appendLine(env.FAKE_LOG, JSON.stringify({ text, priority, busy, session: env.NEXUS_SESSION ?? null }) + "\n");
}

/** The context window a turn reports: FAKE_CONTEXT_WINDOW, else the runtime's own `fallback`. */
export function contextWindow(fake: Fake, fallback: number): number {
  return Number(fake.io.env.FAKE_CONTEXT_WINDOW) || fallback;
}

/** The context tokens a turn reports for a window of `window` tokens: FAKE_CONTEXT_FILL of it, else `fallback`. */
export function contextTokens(fake: Fake, window: number, fallback: number): number {
  const file = fake.io.env.FAKE_CONTEXT_FILL_FILE;
  const fill = file && existsSync(file) ? readFileSync(file, "utf8").trim() : fake.io.env.FAKE_CONTEXT_FILL;
  return fill ? Math.round(Number(fill) * window) : fallback;
}

/** Background work a fake reports: it ends when the file `release` names exists, else after `ms`. */
export interface Background { kind: "command" | "agent"; ms: number; release?: string }

/**
 * Calls `end` when background work ends: once its release file exists (polled; given up after 300 s), else after its
 * time. A time alone raced the engine: under load Nexus took the turn's end in only after the work had ended (queue CI).
 */
export function onBackgroundEnd(fake: Fake, bg: Background, end: () => void): void {
  const release = bg.release;
  if (!release) { later(fake, end, bg.ms); return; }
  const started = Date.now();
  const look = (): void => { if (existsSync(release) || Date.now() - started > 300_000) end(); else later(fake, look, 20); };
  look();
}

export interface Fake {
  /** The runtime's process, or what stands in for it (FakeIo). */
  readonly io: FakeIo;
  /** The fake has ended (endFake): its process exited or was killed. */
  ended?: boolean;
  /** Its timers still to fire (later). */
  timers?: Set<NodeJS.Timeout>;
  /** Ends the running turn's FAKE-SLOW wait early (interrupt). */
  interruptWait?: () => void;
  /** The integration step stopped on a conflict (this turn): it writes no report. */
  stoppedIntegration?: boolean;
  step?: string;
  /** Work this turn leaves running in the background, for the runtime's fake to report after the turn (see the header). */
  background?: Background;
  /** This turn ran a sub-agent in the foreground (FAKE: subagent), for the runtime's fake to report its tokens. */
  subagent?: boolean;
  /** The step asked with FAKE: askslow: the answer's turn works before it reports the step done. */
  answerWork?: boolean;
  /** Every message the agent took in, in order (FAKE-HISTORY shows them). */
  history?: string[];
  /**
   * After this turn the process exits with its stdout held open (FAKE: noopexit1, FAKE-EXIT-HELD; Codex's fake only):
   * a descendant inherits stdout and outlives the process by FAKE_CODEX_HOLD_STDOUT_MS (default 3000), as a command the
   * runtime started may hold the pipe on Windows. Node then emits the exit before stdout ends: the adapter's drain
   * window (codex.ts, EXIT_DRAIN_MS). With FAKE_CODEX_EXIT_GATE set, the turn's last line (turn/completed) is written
   * by that descendant, after the exit, once the file it names exists; the hold counts from then. So a test reads the
   * turn's end inside the window whatever the machine's load: the order Node gives when the exit event comes before
   * the drained line (queue CXD).
   */
  exitHeld?: boolean;
}

/** A notice that a worker asked a question (answered with "fake answer"), and one of a step waiting for its review. */
const ASKED = /A worker asked[\s\S]*?\(qid (\S+);/;
const REVIEW_WAITS = /\bStep (\S+) of queue (\S+) is done and waits for your review/;

/**
 * What a message read during a turn (Claude's `next`, Codex's steer) asks is done before the turn ends, as an agent
 * acts on what it reads mid-turn; its output joins the reply: a command ("FAKE-NEXUS: [args]"), a worker's question,
 * a step waiting for its review (with FAKE_REVIEW_ACCEPT). Without it, a command sent while the orchestrator's fake
 * answered a notice was lost, and the test waited in vain (queue TS1); with the fakes in the test's own process a
 * notice comes into a running turn more often than into a process of its own (queue IPR).
 */
export async function actOnRead(fake: Fake, read: readonly string[], reply: string): Promise<string> {
  const outs: string[] = [];
  for (const t of read) {
    const run = /FAKE-NEXUS: (\[.*\])/.exec(t);
    const asked = ASKED.exec(t);
    const review = REVIEW_WAITS.exec(t);
    if (run) outs.push(await callNexusOut(fake, JSON.parse(run[1]!) as string[]));
    else if (asked) outs.push(await callNexusOut(fake, ["answer", asked[1]!, "fake answer", "--continue"]));
    else if (review && fake.io.env.FAKE_REVIEW_ACCEPT) outs.push(await callNexusOut(fake, ["review", "accept", review[2]!, review[1]!]));
  }
  return outs.length ? [reply, ...outs].join("\n\n") : reply;
}

/**
 * A "slow" step's work: FAKE_SLOW_MS; or, with FAKE_RELEASE set, until the file it names exists, or the file named
 * after it and this step (`<file>-<step>`): the test holds the step at work while it acts, and then lets every step go,
 * or only this one (holdWork in wait.ts; queues TS2, MX), so it neither waits a fixed time nor misses the step at work.
 */
async function work(fake: Fake, step: string): Promise<void> {
  const release = fake.io.env.FAKE_RELEASE;
  if (!release) return sleep(fake, Number(fake.io.env.FAKE_SLOW_MS ?? 1500));
  const released = () => existsSync(release) || existsSync(`${release}-${step}`);
  for (const t = Date.now(); !released() && Date.now() - t < 300_000;) await sleep(fake, 20);
}

/** Ends the running turn's FAKE-SLOW wait early (a stop: Claude's interrupt control, Codex's turn/interrupt). */
export function interrupt(fake: Fake): boolean {
  const f = fake.interruptWait;
  fake.interruptWait = undefined;
  f?.();
  return !!f;
}

/** Waits `ms`, or less when interrupted: true if it was. */
function interruptible(fake: Fake, ms: number): Promise<boolean> {
  return new Promise((r) => {
    let interrupted = false;
    later(fake, () => { if (!interrupted) { fake.interruptWait = undefined; r(false); } }, ms);
    fake.interruptWait = () => { interrupted = true; r(true); };
  });
}

/** The first bytes of a 984×1600 PNG (a 492 px window at scale 2): all nexus review add reads of a picture. */
const PNG_492 = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "ascii"); b.writeUInt32BE(984, 16); b.writeUInt32BE(1600, 20);
  return b;
})();

/** How Claude's fake starts the turn it starts by itself when background work ends (Claude Code: a task notification). */
export const BACKGROUND_NOTICE = "<task-notification>";

/** The text a stopped turn still writes after the interrupt (Claude Code does: a partial assistant message). */
export const PARTIAL = "partial text of the stopped turn";

export type FakeFailure = "overloaded" | "network" | "auth" | "limit" | "crash" | "cloudflare";

/** Whether this turn of the step fails, and how (see the header). */
function failure(fake: Fake, step: string, behaviour: string): FakeFailure | undefined {
  const m = /^(overloaded|network|auth|limit|crash|cloudflare)(\d*)$/.exec(behaviour);
  if (!m) return undefined;
  if (!m[2]) return m[1] as FakeFailure;
  const file = join(dirname(fake.io.env.FAKE_LOG ?? "."), `fake-fails-${step}`);
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (n >= Number(m[2])) return undefined;
  writeFileSync(file, String(n + 1));
  return m[1] as FakeFailure;
}

/**
 * A long Markdown reply (over 3000 characters: headings, paragraphs, a list, a code block, non-ASCII letters), the
 * same every time, so a test can compare what reached a chat byte for byte.
 */
export function longReply(label: string): string {
  const parts = [`## ${label}: what the long reply covers`];
  for (let i = 1; i <= 8; i++) {
    parts.push(`Paragraph ${i}. The mining loop starts slowly on purpose: a player who digs the first shaft by hand learns where ore sits, why the walls need props, and when the water comes. Árvíztűrő tükörfúrógép ${i}. Every later tool only speeds up what the hand already knows.`);
    parts.push(`- Point ${i}.a: props cost wood, and wood is far.\n- Point ${i}.b: water rises one row per minute below the line.\n- Point ${i}.c: ore veins bend toward the old river bed.`);
  }
  parts.push("```ts\nconst shaft = dig({ depth: 12, props: true }); // the first shaft, by hand\n```");
  parts.push(`End of the ${label.toLowerCase()}: nothing after this line was cut.`);
  return parts.join("\n\n");
}

/**
 * Records how the runtime was started or asked (FAKE_ARGS, one JSON line each), for the tests, with what of its
 * environment the tests check (`handover`: NEXUS_HANDOVER, which no runtime may inherit).
 */
export function recordArgs(fake: Fake, what: Record<string, unknown>): void {
  const env = fake.io.env;
  if (env.FAKE_ARGS) appendLine(env.FAKE_ARGS, JSON.stringify({ ...what, handover: env.NEXUS_HANDOVER ?? null }) + "\n");
}

/**
 * The conversations Claude's fake saved, across its processes: one id per line in a file in the test's temporary
 * folder (beside FAKE_LOG, else in NEXUS_HOME, else the system's). Claude Code 2.1.323 saves a session's
 * conversation when it reads the session's first message, not at its start nor at the turn's end (probed
 * 2026-11-15, docs/design/engine-failures.md, "When Claude Code saves a conversation"); a test may mark one saved itself (a session that
 * ran before the test's files). Codex's fake keeps its threads the same way (fake-codex-saved.txt): Codex 0.167.2
 * saves a thread (its rollout file) when the thread's first turn starts, not at thread/start (probed 2026-11-15).
 */
function fakeSavedFile(env: NodeJS.ProcessEnv, runtime: "claude" | "codex"): string {
  const dir = env.FAKE_LOG ? dirname(env.FAKE_LOG) : env.NEXUS_HOME ?? tmpdir();
  mkdirSync(dir, { recursive: true });
  return join(dir, `fake-${runtime}-saved.txt`);
}

export function fakeSaved(id: string, runtime: "claude" | "codex" = "claude", env: NodeJS.ProcessEnv = process.env): boolean {
  const f = fakeSavedFile(env, runtime);
  return existsSync(f) && readFileSync(f, "utf8").split(/\r?\n/).includes(id);
}

export function saveFakeConversation(id: string, runtime: "claude" | "codex" = "claude", env: NodeJS.ProcessEnv = process.env): void {
  if (!fakeSaved(id, runtime, env)) appendFileSync(fakeSavedFile(env, runtime), `${id}\n`);
}

/** The integration step's merge, as its opening asks (see the header). */
async function integrate(fake: Fake, step: string, text: string): Promise<void> {
  const nexus = (...args: string[]) => callNexus(fake, args);
  fake.stoppedIntegration = false;
  const g = ["-c", "user.name=worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false"];
  const git = (...a: string[]) => execFileSync("git", [...g, ...a], { cwd: fake.io.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const stop = /nexus stop \S+ --condition "([^"]+)"/.exec(text)?.[1] ?? "integration conflict";
  const base = /git merge --no-edit (\S+)/.exec(text)?.[1];
  if (!base) { fake.stoppedIntegration = true; await nexus("stop", step, "--condition", stop, "--reason", "fake: no base branch to merge"); return; }
  try { git("merge", "--no-edit", base); }
  catch {
    const files = git("diff", "--name-only", "--diff-filter=U").split(/\r?\n/).filter(Boolean);
    const giveUp = fake.io.env.FAKE_INTEGRATE_GIVE_UP;
    if (/- A conflict: resolve it/.test(text) && !(giveUp && existsSync(giveUp))) {
      for (const f of files) { git("checkout", "--ours", "--", f); git("add", "--", f); }
      git("commit", "--no-edit", "-q");
      await nexus("step", "done", step, "--summary", `fake merged ${base}, resolved ${files.join(", ")}`, "--commit", git("rev-parse", "HEAD"));
      return;
    }
    git("merge", "--abort");
    fake.stoppedIntegration = true;
    await nexus("stop", step, "--condition", stop, "--reason", `fake: conflict in ${files.join(", ")} not resolved`);
    return;
  }
  await nexus("step", "done", step, "--summary", `fake merged ${base}`, "--commit", git("rev-parse", "HEAD"));
}

/** A Write the runtime's --disallowedTools rules refuse (Claude's form for an absolute path: Write(//C:/x/**)). */
function writeDenied(fake: Fake, path: string): boolean {
  const p = path.replaceAll("\\", "/").toLowerCase();
  return fake.io.argv.flatMap((a) => a.split(",")).some((a) => {
    const m = /^Write\(\/\/(.+)\/\*\*\)$/.exec(a);
    return !!m && p.startsWith(m[1]!.toLowerCase() + "/");
  });
}

/**
 * Does what the message asks and returns the agent's reply, or the failure the runtime should show for this turn.
 * `tool` reports a shell command it ran.
 */
export async function respond(fake: Fake, text: string, tool: (command: string) => void, refused?: () => void): Promise<string | { fail: FakeFailure } | { exit: true } | { interrupted: true }> {
  const { env, cwd } = fake.io;
  const nexus = (...args: string[]) => callNexus(fake, args);
  const nexusOut = (args: string[], input?: string) => callNexusOut(fake, args, input);
  const helper = /^\[Nexus\] Review step (\S+) of queue (\S+), round (\d+)/.exec(text);
  if (helper) return reviewAsHelper(fake, text, helper[2]!, helper[1]!, Number(helper[3]), tool, refused);
  const m = /step (\S+) \(\d+ of \d+\)/.exec(text);
  if (/(^|\n)\[Nexus\] Queue/.test(text) && m) {
    const step = (fake.step = m[1]!);
    // Kept beside FAKE_LOG too, so a new process of the session (after a restart) knows the step an answer is for.
    if (env.FAKE_LOG && env.NEXUS_SESSION) writeFileSync(join(dirname(env.FAKE_LOG), `fake-step-${env.NEXUS_SESSION}`), step);
    // The closing refactoring step (no FAKE: in its standard goal): FAKE_CLOSING, else done.
    const closing = text.includes("This is the queue's closing refactoring step");
    const integration = text.includes("This is the queue's integration step");
    let behaviour = /FAKE: (\w+)/.exec(text)?.[1] ?? (closing ? env.FAKE_CLOSING : undefined) ?? (integration ? env.FAKE_INTEGRATE ?? "merge" : undefined) ?? "done";
    await nexus("step", "start", step);
    tool(`nexus step start ${step}`);
    // Real OS descendants under the fake runtime: one direct sleeper and an orphaned grandchild. The intermediate
    // exits before the turn reports its outcome, which a process-list snapshot cannot reliably reconstruct.
    if (behaviour.startsWith("proc")) {
      const file = `${env.FAKE_LOG}.children-${step}`;
      const direct = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      direct.unref();
      const bridge = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "fake-descendant.ts"), file, String(process.pid), String(direct.pid)], { stdio: "ignore", windowsHide: true });
      await new Promise<void>((resolve, reject) => { bridge.once("error", reject); bridge.once("exit", () => resolve()); });
      if (behaviour === "prochold") await work(fake, step);
      if (behaviour === "proccrash") { fake.io.exit(1); return never(); }
      behaviour = behaviour === "procstop" ? "stop" : "done";
    }
    // Own a real Windows directory handle, optionally denying new PROCESS_TERMINATE handles. Held until the test
    // lets this turn finish; the worker job must release it before the next step. No model or foreign process.
    if (behaviour === "ownedhold" || behaviour === "owneddeny") {
      const dir = join(cwd, `.owned-${step}`);
      mkdirSync(dir, { recursive: true });
      const ready = `${env.FAKE_LOG}.helper-${step}`;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(dirname(fileURLToPath(import.meta.url)), "worker-helper.ps1"),
        "-Ready", ready, "-Release", `${ready}.release`, ...(behaviour === "owneddeny" ? ["-DenyTerminate"] : [])],
      { cwd: dir, stdio: "ignore", windowsHide: true });
      child.unref();
      await work(fake, step);
      behaviour = "done";
    }
    const fail = failure(fake, step, behaviour);
    if (fail) return { fail };
    if (/^(overloaded|network|auth|limit|crash|cloudflare)/.test(behaviour)) await nexus("step", "done", step, "--summary", `fake finished ${step} after failures`);
    if (behaviour === "slow" || behaviour === "slownoop" || behaviour === "slowask") await work(fake, step);
    if (behaviour === "checks" || behaviour === "shortchecks") {
      const listed = /\nChecks for every step:\n((?:- .*(?:\n|$))+)/.exec(text)?.[1] ?? "";
      for (const name of listed.split("\n").filter(Boolean).map((l) => l.slice(2).trim())) {
        const args = ["check", step, behaviour === "checks" ? name : name.split(" ").at(-1)!, "--ok", "--summary", "fake run", "--duration", "1"];
        if (behaviour === "checks") await nexus(...args); else await nexusOut(args); // the short names are refused (queue ACX, W4)
      }
    }
    // "commit": a commit in the working directory (a file named after the step), then done.
    // "commitstop": the same commit, then a stop condition (as the worker briefing asks: commit, then stop).
    if (behaviour === "commit" || behaviour === "commitstop") {
      writeFileSync(join(cwd, `${step}.txt`), `${step}\n`);
      const g = ["-c", "user.name=worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false"];
      execFileSync("git", [...g, "add", `${step}.txt`], { cwd, stdio: "ignore" });
      execFileSync("git", [...g, "commit", "-q", "-m", `${step} work`], { cwd, stdio: "ignore" });
      if (behaviour === "commit") await nexus("step", "done", step, "--summary", `fake committed ${step}`);
      else await nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop after a commit");
    }
    if (behaviour === "untracked") {
      writeFileSync(join(cwd, `${step}-left.txt`), "left behind\n");
      await nexus("step", "done", step, "--summary", `fake finished ${step}, leaving ${step}-left.txt`);
    }
    if (behaviour === "merge") await integrate(fake, step, text);
    if (behaviour === "review") {
      const dir = join(tmpdir(), "nexus-review", step);
      mkdirSync(dir, { recursive: true });
      const shot = join(dir, `${step.toLowerCase()}-shot@492.png`), note = join(dir, "notes.md");
      writeFileSync(shot, PNG_492); writeFileSync(note, `# Review notes of ${step}
`);
      await nexus("review", "add", step, shot, "--key", `${step.toLowerCase()}-shot@492`, "--role", "result", "--label", `${step} shot`);
      await nexus("review", "add", step, note, "--label", `${step} notes`);
      await nexus("step", "done", step, "--summary", `fake finished ${step} with review material`);
    }
    if (behaviour === "subagent") {
      fake.subagent = true;
      await nexus("step", "done", step, "--summary", `fake finished ${step} with a sub-agent`);
    }
    if (behaviour === "metric") {
      for (const [, name, value] of text.matchAll(/FAKE-METRIC: (\S+) (\S+)/g)) await nexus("metric", "record", name!, value!);
      await nexus("step", "done", step, "--summary", `fake finished ${step} with its metrics`);
    }
    if (behaviour === "refused") { refused?.(); await nexus("step", "done", step, "--summary", `fake finished ${step} without what was refused`); }
    // A closing refactoring step done finds nothing worth refactoring.
    if (["done", "slow", "summary", "summaryslow", "checks", "shortchecks"].includes(behaviour)) await nexus("step", "done", step, "--summary", closing ? `fake: nothing in ${step} is worth refactoring, the change is too small` : `fake finished ${step}`);
    if (behaviour.startsWith("summary")) await nexus("context", `fake summary of ${step}`, "--topics", "fake,context");
    if (behaviour === "summaryslow") await work(fake, step);
    if (behaviour === "fail") await nexus("step", "failed", step, "--reason", "fake failure");
    if (behaviour === "doneexit" || behaviour === "doneexitheld") {
      await nexus("step", "done", step, "--summary", `fake finished ${step}, then exits`);
      if (behaviour === "doneexitheld") await work(fake, step); // accept review before the runtime's exit arrives
      return { exit: true };
    }
    if (behaviour === "stop") await nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop");
    // stop1: a stop condition on the step's first turn; once the stop is lifted, the step is done.
    if (behaviour === "stop1") {
      const file = join(dirname(env.FAKE_LOG ?? "."), `fake-stops-${step}`);
      if (existsSync(file)) await nexus("step", "done", step, "--summary", `fake finished ${step} after the stop was lifted`);
      else { writeFileSync(file, "1"); await nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop"); }
    }
    if (behaviour === "ask" || behaviour === "slowask" || behaviour === "askslow") await nexus("ask", "Which way?", "--step", step);
    if (behaviour === "askslow") fake.answerWork = true;
    if (behaviour === "askwork") { await nexus("ask", "Which way?", "--step", step, "--can-continue"); await work(fake, step); }
    if (behaviour === "askthree") {
      for (const text of ["Which layout?", "Which colour?", "Which sound?"]) await nexus("ask", text, "--step", step, "--can-continue", "--option", "First", "--option", "Second", "--recommend", "First");
      if (env.FAKE_ASK_LINGER_MS) await sleep(fake, Number(env.FAKE_ASK_LINGER_MS));
    }
    // ask1 and partial: what they do the first time, counted in a file beside FAKE_LOG (any session of the step).
    const first = (kind: string) => {
      const file = join(dirname(env.FAKE_LOG ?? "."), `fake-${kind}-${step}`);
      if (existsSync(file)) return false;
      writeFileSync(file, "1");
      return true;
    };
    if (behaviour === "ask1") {
      if (first("ask1")) {
        await nexus("ask", "Which way?", "--step", step);
        if (env.FAKE_ASK_LINGER_MS) await sleep(fake, Number(env.FAKE_ASK_LINGER_MS));
      }
      else await nexus("step", "done", step, "--summary", `fake finished ${step} after its question`);
    }
    if (behaviour === "noopexit1") {
      if (first("noopexit1")) fake.exitHeld = true;
      else await nexus("step", "done", step, "--summary", `fake finished ${step} after its process exited`);
    }
    if (behaviour === "partial") {
      if (first("partial")) {
        await nexus("step", "progress", step, "half way", "--pct", "50");
        const g = ["-c", "user.name=worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false"];
        writeFileSync(join(cwd, `${step}-a.txt`), "first\n");
        execFileSync("git", [...g, "add", `${step}-a.txt`], { cwd, stdio: "ignore" });
        execFileSync("git", [...g, "commit", "-q", "-m", `${step} first half`], { cwd, stdio: "ignore" });
        writeFileSync(join(cwd, `${step}-a.txt`), "first\nsecond\n");
        writeFileSync(join(cwd, `${step}-b.txt`), "not committed\n");
      } else if (existsSync(join(cwd, `${step}-b.txt`))) await nexus("step", "done", step, "--summary", `fake finished ${step}: kept the uncommitted work`);
      else await nexus("step", "failed", step, "--reason", "the uncommitted work is gone");
    }
    if (behaviour === "background" || behaviour === "bgagent" || behaviour === "bglong") {
      fake.background = behaviour === "bglong"
        ? { kind: "command", ms: Number(env.FAKE_BG_LONG_MS ?? 600_000) }
        : { kind: behaviour === "bgagent" ? "agent" : "command", ms: Number(env.FAKE_BG_MS ?? 1500), release: env.FAKE_BG_RELEASE };
    }
    // The queue's last step done: the report, written where the prompt says (refused under a denied folder, as
    // Claude Code refuses a Write its --disallowedTools rule covers), then registered with nexus report.
    const report = /`nexus report (\S+) --file (\S+) --summary/.exec(text);
    if (report && (["done", "untracked", "slow", "commit"].includes(behaviour) || (behaviour === "merge" && !fake.stoppedIntegration))) {
      const path = resolve(cwd, report[2]!);
      if (!writeDenied(fake, path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# Queue ${report[1]} report\n\nfake report of the whole queue\n`);
        // Tests running side by side may share a project id and so a report file: a refusal here is not the test's subject.
        // "FAKE-FINDINGS: <n>" in the goal: the number of findings, given as a maintenance queue's report gives it.
        const findings = /FAKE-FINDINGS: (\d+)/.exec(text)?.[1];
        try { await nexus("report", report[1]!, "--file", path, "--summary", `fake report of ${report[1]}`, ...(findings ? ["--findings", findings] : [])); } catch { /* another test took it */ }
      }
    }
    return `step ${step}: ${behaviour}`;
  }
  const stepFile = env.FAKE_LOG && env.NEXUS_SESSION ? join(dirname(env.FAKE_LOG), `fake-step-${env.NEXUS_SESSION}`) : undefined;
  fake.step ??= stepFile && existsSync(stepFile) ? readFileSync(stepFile, "utf8") : undefined;
  // Background work ended: Claude Code's own turn with the task's notification, or Nexus's nudge after it (Codex).
  if ((text.startsWith(BACKGROUND_NOTICE) || text.startsWith("[Nexus] The background work you started has finished")) && fake.step) {
    await nexus("step", "done", fake.step, "--summary", `fake finished ${fake.step} after its background work`);
    return "background done";
  }
  if (text.startsWith("[Nexus] Answer") && fake.step) {
    if (fake.answerWork) await work(fake, fake.step);
    await nexus("step", "done", fake.step, "--summary", `fake finished ${fake.step} after an answer`);
    return "answered";
  }
  // A check-fix round (the checks Nexus ran failed): with FAKE_CHECK_DISPUTE naming a check that failed, say once (per
  // step) that its failure is not this work's and end the turn; otherwise "fix" it (FAKE_CHECK_FIX_MS long) and report
  // the step done again.
  const fix = /^\[Nexus\] The checks Nexus ran for step (\S+) of queue \S+: check-fix round (\d+)/.exec(text);
  if (fix) {
    const step = fix[1]!;
    const dispute = env.FAKE_CHECK_DISPUTE;
    const marker = join(dirname(env.FAKE_LOG ?? "."), `fake-disputed-${step}`);
    // "*": the first check the message says failed.
    const name = dispute === "*" ? /Check "(.+)" failed/.exec(text)?.[1] : dispute;
    if (name && !existsSync(marker) && text.includes(`Check "${name}" failed`)) {
      writeFileSync(marker, "1");
      const out = await nexusOut(["check", step, name, "--unrelated", "--evidence", "it fails on the base too"]);
      return `disputed: ${out}`;
    }
    await nexus("step", "start", step);
    // FAKE_CHECK_FIX_MS: the fix takes that long (a picture of the round at work; a stop ends it early).
    if (env.FAKE_CHECK_FIX_MS && await interruptible(fake, Number(env.FAKE_CHECK_FIX_MS))) return { interrupted: true };
    await nexus("step", "done", step, "--summary", `fake fixed ${step} in check-fix round ${fix[2]}`);
    return `check-fix round ${fix[2]}`;
  }
  // A step sent back (by the orchestrator or the user's Fix it): work on it again and report it done.
  const back = /^\[Nexus\] (?:The (?:orchestrator|review helper) reviewed|The user sent) step (\S+) of queue \S+ .*\(round (\d+)\)/.exec(text);
  if (back) {
    await nexus("step", "start", back[1]!);
    await nexus("step", "done", back[1]!, "--summary", `fake finished ${back[1]} round ${back[2]}`);
    return `round ${back[2]}`;
  }
  if (text.startsWith("[Nexus] Your context holds") && text.includes("fresh orchestrator session")) {
    if (!env.FAKE_NO_SUMMARY) await nexus("context", "fake orchestrator summary", "--topics", "plan,promises", "--files", "docs/plan.md");
    if (env.FAKE_SUMMARY_MS) await sleep(fake, Number(env.FAKE_SUMMARY_MS));
    return "summary written";
  }
  if (text.includes("write your context summary")) {
    // FAKE_SUMMARY_FAIL: the request's turn fails that way (a failure kind, as a step's behaviour names it).
    if (env.FAKE_SUMMARY_FAIL) return { fail: env.FAKE_SUMMARY_FAIL as FakeFailure };
    if (!env.FAKE_NO_SUMMARY && fake.step) await nexus("context", `fake summary of ${fake.step}, on request`, "--topics", "fake");
    return "summary";
  }
  if (text.includes("hands this conversation to the orchestrator")) return longReply("SUMMARY");
  if (text.includes("FAKE-LONG")) return longReply("Reply");
  if (text.includes("FAKE-HOLD")) {
    tool("waiting for release (FAKE-HOLD)");
    await work(fake, "chat");
    return "held reply";
  }
  if (text.includes("FAKE-SLOW") || env.FAKE_CHAT_SLOW_ALL) {
    tool("sleep (FAKE-SLOW)");
    return (await interruptible(fake, Number(env.FAKE_CHAT_SLOW_MS ?? 4000))) ? { interrupted: true } : "slow reply";
  }
  if (text.includes("FAKE-EXIT-HELD")) { fake.exitHeld = true; return "exit reply"; }
  if (text.includes("FAKE-HISTORY")) return `history: ${(fake.history ?? []).join(" | ")}`;
  const draft = /FAKE-DRAFT:\s*\n([\s\S]*)$/.exec(text);
  if (draft) return await nexusOut(["queue", "draft", "-"], draft[1]);
  const run = /FAKE-NEXUS: (\[.*\])/.exec(text);
  if (run) return await nexusOut(JSON.parse(run[1]!) as string[]);
  const script = /FAKE-SCRIPT: (.+)/.exec(text);
  if (script) {
    try { return execFileSync(process.execPath, [script[1]!.trim()], { env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch (e) { return `script failed: ${(e as { stderr?: string }).stderr ?? errorText(e)}`; }
  }
  const asked = ASKED.exec(text);
  if (asked) return await nexusOut(["answer", asked[1]!, "fake answer", "--continue"]);
  // With FAKE_REVIEW_ACCEPT set, a step waiting for its review is accepted (tests about something other than review).
  const review = REVIEW_WAITS.exec(text);
  if (review && env.FAKE_REVIEW_ACCEPT) return await nexusOut(["review", "accept", review[2]!, review[1]!]);
  return "ok"; // a nudge, a message sent while idle, anything else
}

/** A review helper's turn (see the header): the verdict its step's goal asks for. */
async function reviewAsHelper(fake: Fake, text: string, queue: string, step: string, round: number, tool: (command: string) => void, refused?: () => void): Promise<string> {
  const level3 = text.includes("Review level 3");
  const verdict = /FAKE-HELPER: (\S+)/.exec(text)?.[1] ?? (level3 ? "passon:level" : "accept");
  const run = (args: string[]) => { tool(`nexus ${args.join(" ")}`); return callNexusOut(fake, args); };
  if (verdict === "none") return "fake helper: no verdict";
  if (verdict === "hang") { await work(fake, step); return "fake helper: no verdict after work"; }
  if (verdict === "accept" || (verdict === "sendback1" && round > 1)) return await run(["review", "accept", queue, step, "--note", `fake helper checked round ${round}`]);
  if (verdict === "sendback" || verdict === "sendback1") return await run(["review", "send-back", queue, step, `fake helper: fix round ${round}`]);
  if (verdict.startsWith("passon:")) return await run(["review", "pass-on", queue, step, "--why", verdict.slice(7), "--findings", `fake helper findings for ${step}`]);
  if (verdict === "refused") {
    refused?.();
    const asked = await run(["ask", "May I push?", "--step", step]);
    return await run(["review", "pass-on", queue, step, "--why", "doubt", "--findings", `fake helper: git push was refused; ${asked}`]);
  }
  return `fake helper: unknown verdict ${verdict}`;
}

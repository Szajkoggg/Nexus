// AgentHost: starts the agent processes of one role (workers, the orchestrator, thinking partners, review helpers), one per session,
// and keeps what every role keeps the same way: the session's runtime record (sessions/<id>/runtime.json), the facts
// read from the runtime's stream (the record, the runtime's own session id, the account's usage windows), and ending a
// process so that the session's next message starts a new one. What a role does with its agent's texts, turns and
// exits stays with the role: it gives its handlers when it starts a process.
import { join } from "node:path";
import {
  appendTurn, now, readUsage, stepDefs, stepTags, writeUsage, type ProjectStore, type RuntimeFile, type SessionFile, type TokenCounts, type TurnRecord,
} from "@nexus/protocol";
import { reachable, type ActivityItem, type AgentEvents, type AgentProcess, type RefusalItem, type StreamFacts, type TurnTokens } from "./agent.ts";
import { ClaudeSession, type ClaudeOptions } from "./claude.ts";
import { CodexSession, type CodexOptions } from "./codex.ts";

/**
 * What a role's runtime record keeps besides the process id, the state, the model and the context. Kept per role as it
 * was when the processes moved onto AgentHost (queue R2); the dashboard and the orchestrator read these records.
 */
export interface RoleRecord {
  /** The runtime's cost (`cost_usd`, Claude Code's running total). */
  cost: boolean;
  /** A turn's start (the model fact) marks the record `working`; otherwise only the context tokens of a reply do. */
  workingFromModel: boolean;
  /** Each turn's end counts in `turns`; otherwise `turns` stays 0. */
  countTurns: boolean;
}

export const ROLE_RECORDS = {
  worker: { cost: true, workingFromModel: true, countTurns: true },
  orchestrator: { cost: true, workingFromModel: false, countTurns: false },
  conversation: { cost: false, workingFromModel: false, countTurns: false },
  helper: { cost: true, workingFromModel: true, countTurns: true },
} as const satisfies Record<string, RoleRecord>;

/** A Claude Code session's briefing, in its session folder (ClaudeOptions.briefingFile). */
const BRIEFING_FILE = "briefing.md";

/** Which runtime to start, with its options. */
export type Launch = { runtime: "claude"; options: ClaudeOptions } | { runtime: "codex"; options: CodexOptions };

/** A role's handlers for its process's events; each runs after AgentHost has kept its records. */
export interface HostHandlers {
  message?(text: string): void;
  activity?(a: ActivityItem): void;
  refusal?(r: RefusalItem): void;
  facts?(f: StreamFacts): void;
  turnEnd?(end: AgentEvents["turnEnd"][0]): void;
  /** The work the agent left running in the background changed (AgentProcess.background). */
  background?(work: readonly string[]): void;
  /** The runtime compacted the conversation's context (AgentProcess.compact). */
  compacted?(c: AgentEvents["compacted"][0]): void;
  /** The process stopped settling after a turn's end with no turn of the runtime's own (AgentProcess.settling). */
  settled?(): void;
  /** `byNexus`: the process was ended through AgentHost (retire, close, restartAfterTurn, shutdown). */
  exit?(code: number | null, byNexus: boolean): void;
  /** The queue and step a turn works on, for its record (a worker's run); asked when the turn begins. */
  tag?(): TurnTag;
}

/** A turn in progress, for its record: when it began, the windows then, what it works on. */
/** `startedMs`: the monotonic clock at the start, for the turn's duration (a clock step does not change it). */
interface OpenTurn { started: string; startedMs: number; windows?: TurnRecord["windows_start"]; tag: TurnTag }
/** What a turn works on, for its record: the queue and step, and the fallback the step runs on, if it does. */
type TurnTag = { queue?: string; step?: string; fallback?: TurnRecord["fallback"] };

/** A runtime's token counts as turns.jsonl keeps them. */
const tokenCounts = (t: TurnTokens | undefined): TokenCounts | undefined =>
  t && { input: t.input, output: t.output, cache_read: t.cacheRead, cache_creation: t.cacheCreation };

/** A session's running process, with what the role keeps beside it (`E`). */
export type Hosted<E extends object = object> = { readonly session: string; readonly proc: AgentProcess } & E;

export interface AgentHostOptions {
  /** Makes the process; tests give a stand-in. By default a ClaudeSession or a CodexSession. */
  spawn?: (launch: Launch) => AgentProcess;
  /** Which runtimes compact a conversation on request; tests name one that does not. By default COMPACTS (agent.ts). */
  compacts?: (runtime: "claude" | "codex") => boolean;
  /**
   * How long after a Claude turn's end a turn of the CLI's own may still begin (ClaudeOptions.lateTurnMs), for every
   * Claude process this host starts whose launch does not set it. Tests shorten it, or hold it open, so that the
   * settling and its `settled` end are not bound to the default's timing; by default Claude's own (claude.ts).
   */
  lateTurnMs?: number;
}

/** A launch's settings, without what differs between any two starts of one session (see AgentHost.stale). */
function launchKey(launch: Launch, ignore: readonly string[] = []): string {
  const { resume: _r, env: _e, uuid: _u, threadId: _t, ...rest } = launch.options as unknown as Record<string, unknown>;
  for (const k of ignore) delete rest[k];
  return JSON.stringify([launch.runtime, rest]);
}

function spawnRuntime(launch: Launch): AgentProcess {
  return launch.runtime === "codex" ? new CodexSession(launch.options) : new ClaudeSession(launch.options);
}

export class AgentHost<E extends object = object> {
  private readonly store: ProjectStore;
  private readonly record: RoleRecord;
  private readonly spawn: (launch: Launch) => AgentProcess;
  private readonly lateTurnMs: number | undefined;
  private readonly live = new Map<string, Hosted<E>>();
  /** What each process was started with, to tell when the settings changed since (stale). */
  private readonly launched = new WeakMap<AgentProcess, Launch>();
  /** Processes ended through AgentHost: their exit is no failure. */
  private readonly ended = new WeakSet<AgentProcess>();
  /** Processes to end when their running turn ends. */
  private readonly afterTurn = new WeakSet<AgentProcess>();
  /**
   * What each process's turns answer (sent through `send`): the texts sent into the running turn (or the one they
   * started), and those waiting as the turn after it. For a restart that cuts the turn off (cutOff).
   */
  private readonly asked = new WeakMap<AgentProcess, { turn: string[]; next: string[] }>();

  constructor(store: ProjectStore, record: RoleRecord, options: AgentHostOptions = {}) {
    this.store = store;
    this.record = record;
    this.spawn = options.spawn ?? spawnRuntime;
    this.lateTurnMs = options.lateTurnMs;
  }

  /** The variables every agent's process gets: its session and the project's .nexus. */
  env(session: string): Record<string, string> {
    return { NEXUS_SESSION: session, NEXUS_DIR: this.store.dir };
  }

  /** The session's process as last started (it may have exited since). */
  get(session: string): Hosted<E> | undefined { return this.live.get(session); }

  /** The session's process if it has not exited. */
  running(session: string): Hosted<E> | undefined {
    const l = this.live.get(session);
    return l && l.proc.state !== "exited" ? l : undefined;
  }

  /**
   * The session's process if a message can reach it (agent.ts, reachable). A role that answers the user's messages
   * starts a new one otherwise.
   */
  reachable(session: string): Hosted<E> | undefined {
    const l = this.live.get(session);
    return l && reachable(l.proc) ? l : undefined;
  }

  /** The processes as last started, by session. */
  all(): Hosted<E>[] { return [...this.live.values()]; }

  /**
   * No process is in the middle of a turn, nor settling after one (AgentProcess.settling): then a turn of the
   * runtime's own may still start with a message sent into the last one, which an update's drain ending the process
   * now would lose (queue LH). Settling lasts a moment (lateTurnMs).
   */
  idle(): boolean { return !this.all().some((l) => l.proc.state === "working" || (l.proc.state === "idle" && !!l.proc.settling)); }

  /** A process is still running (after shutdown: not yet exited). */
  alive(): boolean { return this.all().some((l) => l.proc.state !== "exited"); }

  /**
   * Starts a process for the session. `launch` gets whether the runtime resumes the session and says what to start;
   * `handlers` get the hosted entry, with the role's own `extra` fields. A session resumes when it ran before (it has
   * a runtime record) and its runtime saved its conversation: Claude Code saves it only when it reads the first
   * message, so a process that ended before left nothing to resume (`--resume` then fails with "No conversation
   * found"), and the session starts afresh with the same id. A record without the mark (`conversation_saved`, written
   * before queue RN) is taken as saved: no conversation that may exist is dropped (docs/design/engine.md, "When Claude Code saves
   * a conversation").
   */
  start(session: SessionFile, launch: (resume: boolean) => Launch, extra: E, handlers: (l: Hosted<E>) => HostHandlers): Hosted<E> {
    const record = this.store.readRuntime(session.id);
    const resume = record !== undefined && record.conversation_saved !== false;
    const how = launch(resume);
    // `launched` keeps the launch without the briefing's file: it is no setting (stale).
    const late = how.runtime === "claude" && how.options.lateTurnMs === undefined && this.lateTurnMs !== undefined ? { lateTurnMs: this.lateTurnMs } : {};
    const owned = { ...how, options: { ...how.options, ...late, ownProcesses: session.role === "worker" ? true : undefined, agentRole: session.role } } as Launch;
    const proc = this.spawn(this.withBriefingFile(session.id, owned));
    // Whatever the agent is given to act on comes with the server's clock mark in .nexus/clock.json, so its `nexus`
    // calls stamp their records after everything the server had seen (docs/design/state.md, "Clock steps").
    const send = proc.send.bind(proc);
    proc.send = (text, priority) => {
      try { this.store.writeClock(); } catch (e) { console.error(`clock.json: ${(e as Error).message}`); }
      send(text, priority);
    };
    const l = { ...extra, session: session.id, proc } as Hosted<E>;
    this.live.set(session.id, l);
    this.launched.set(proc, how);
    // A fresh Claude Code session is unsaved until its process says otherwise (facts `saved`).
    this.write(session.id, { state: "idle", pid: proc.pid, ...(!resume && how.runtime === "claude" ? { conversation_saved: false } : {}) });
    const on = handlers(l);
    // The per-turn record (turns.jsonl): a turn begins with the runtime's turn start, or else with the first thing it
    // streams after the previous turn's end.
    let open: OpenTurn | undefined;
    let model: string | undefined;
    // A turn that begins marks the record `working`, so `idle` always means between turns: a Codex reply's text comes
    // before its token figures, and a record still `idle` from the start then read as a turn already over (queue FU4).
    const begin = (mark = true) => {
      if (open) return;
      open = { started: now(), startedMs: performance.now(), windows: this.windows(session.runtime), tag: on.tag?.() ?? {} };
      if (mark) this.write(session.id, { state: "working" });
    };
    proc.on("message", (text) => { begin(); on.message?.(text); });
    // Not an error line: a process that exits writes one after its last turn, and that is no new turn.
    proc.on("activity", (a) => { if (a.kind !== "error") begin(); on.activity?.(a); });
    proc.on("refusal", (r) => on.refusal?.(r));
    proc.on("background", (w) => on.background?.(w));
    proc.on("compacted", (c) => on.compacted?.(c));
    // A restart held for the end of a turn (restartAfterTurn): its process ends now, the next start makes a new one.
    const endHeld = () => { this.afterTurn.delete(proc); this.ended.add(proc); proc.kill(); this.forget(l); };
    proc.on("settled", () => {
      // A restart held for the moment a turn of the runtime's own could still start (turnEnd below): none came.
      if (this.afterTurn.has(proc) && proc.state === "idle") endHeld();
      on.settled?.();
    });
    proc.on("facts", (f) => {
      if (f.model) model = f.model;
      if (f.contextTokens !== undefined) begin();
      this.facts(session.id, f); on.facts?.(f);
    });
    proc.on("turnEnd", (end) => {
      const a = this.asked.get(proc);
      // A turn sent to follow this one (send's afterTurn: a hand-over asked during it) starts now in this process.
      const queued = !!a?.next.length;
      if (a) this.asked.set(proc, { turn: a.next, next: [] });
      begin(false);
      this.recordTurn(session, open!, model, end);
      const last = { started_at: open!.started, ended_at: now() };
      open = undefined;
      this.write(session.id, this.record.countTurns ? { state: "idle", last_turn: last, turns: (this.store.readRuntime(session.id)?.turns ?? 0) + 1 } : { state: "idle", last_turn: last });
      // A restart after the turn: not while the runtime may still run a message sent into this turn as a turn of its
      // own (AgentProcess.settling, queue KM): killed now, the process would take that message with it. It ends after
      // that turn, or once the moment is over (settled). Nor while a turn sent to follow this one is queued in the
      // process: killed now, it would take that turn with it; the process ends after it (queue CM).
      if (this.afterTurn.has(proc) && !proc.settling && !queued) endHeld();
      on.turnEnd?.(end);
    });
    proc.on("exit", (code) => {
      // A turn its process did not finish (a kill, an update's drain, a crash): recorded as interrupted.
      if (open) { this.recordTurn(session, open, model, undefined); open = undefined; }
      // The session's record belongs to the process that runs it now: one started while this one's exit was still
      // being read (AgentProcess.exiting), or after it was let go, has written its own (queue CXD).
      const replaced = this.live.has(session.id) && this.live.get(session.id) !== l;
      if (!replaced) this.write(session.id, { state: "exited" });
      this.forget(l);
      on.exit?.(code, this.ended.has(proc));
    });
    return l;
  }

  /** A Claude Code briefing goes in the session's own file (sessions/<id>/briefing.md), not on the command line. */
  private withBriefingFile(session: string, how: Launch): Launch {
    if (how.runtime !== "claude") return how;
    return { ...how, options: { ...how.options, briefingFile: join(this.store.sessionDir(session), BRIEFING_FILE) } };
  }

  /**
   * Whether the session's running process was started with other settings than `launch` gives now (the project's
   * settings changed: a model, a permission mode, an allow rule, a sandbox, a briefing). What differs between any two
   * starts of one session (resuming, its ids, the environment) does not count, nor what `ignore` names (a role that
   * changes those by other means). False without a running process.
   */
  stale(session: string, launch: (resume: boolean) => Launch, ignore: readonly string[] = []): boolean {
    const l = this.running(session);
    const was = l && this.launched.get(l.proc);
    return !!was && launchKey(was, ignore) !== launchKey(launch(true), ignore);
  }

  /** The model and effort the session's running process was started with (none set: the runtime's default). */
  launchedWith(session: string): { model?: string; effort?: string } | undefined {
    const l = this.running(session);
    const how = l && this.launched.get(l.proc);
    return how && { model: how.options.model, effort: how.options.effort };
  }

  /**
   * Ends the session's process without cutting a turn short: after its running turn (its input closes), else now.
   * The session's next start makes a new process.
   */
  retire(session: string): void {
    const l = this.live.get(session);
    if (!l) return;
    this.ended.add(l.proc);
    if (l.proc.state === "working") l.proc.close(); else l.proc.kill();
    this.live.delete(session);
  }

  /** Closes the process's input (it ends after its running turn); the session's next start makes a new process. */
  close(session: string): void {
    const l = this.live.get(session);
    if (!l) return;
    this.ended.add(l.proc);
    l.proc.close();
    this.live.delete(session);
  }

  /**
   * A new process from the next message on (another model or effort): a working process is ended when its turn ends,
   * a settling one when its moment is over (or after the turn it still starts), an idle one now.
   */
  restartAfterTurn(session: string): void {
    const l = this.running(session);
    if (!l) return;
    if (l.proc.state === "working" || l.proc.settling) { this.afterTurn.add(l.proc); return; }
    this.ended.add(l.proc);
    l.proc.kill();
    this.live.delete(session);
  }

  /**
   * Sends `text` to the hosted process: into its running turn, or as a turn of its own when it is idle; with
   * `afterTurn`, as the turn after the running one. Remembers `quote` (by default the text) as what that turn answers:
   * what a restart that cuts the turn off quotes (cutOff). Empty: the turn answers nothing worth quoting.
   */
  send(l: Hosted<E>, text: string, o: { afterTurn?: boolean; quote?: readonly string[] } = {}): void {
    const later = l.proc.state === "working" && !!o.afterTurn;
    const a = this.asked.get(l.proc) ?? { turn: [], next: [] };
    (later ? a.next : a.turn).push(...(o.quote ?? [text]));
    this.asked.set(l.proc, a);
    l.proc.send(text, l.proc.state === "working" && !later ? "next" : undefined);
  }

  /**
   * Before the hand-over to the next server (an update): every process in the middle of a turn has the turn stopped,
   * and its session's runtime record keeps what the turn answered (`interrupted`), for the next server to go on with
   * (interruption, resumed). `extra` adds what the role keeps of the turn. Returns the sessions cut off.
   */
  cutOff(extra: (l: Hosted<E>) => { handoff?: boolean; asked?: readonly string[] } = () => ({})): string[] {
    const cut: string[] = [];
    for (const l of this.live.values()) {
      if (l.proc.state !== "working") continue;
      const a = this.asked.get(l.proc);
      // `asked` of the role's: what it holds back for the session's next process (a conversation's waiting input).
      const { asked: more = [], ...rest } = extra(l);
      this.write(l.session, { interrupted: { at: now(), asked: [...(a?.turn ?? []), ...(a?.next ?? []), ...more], ...rest } });
      l.proc.stop();
      cut.push(l.session);
    }
    return cut;
  }

  /** The session's turn a hand-over cut off (cutOff), not gone on with yet. */
  interruption(session: string): RuntimeFile["interrupted"] {
    return this.store.readRuntime(session)?.interrupted;
  }

  /** The session goes on with the turn a hand-over cut off: its record drops it. */
  resumed(session: string): void {
    if (this.interruption(session)) this.write(session, { interrupted: undefined });
  }

  /** Kills every process (the server stops). */
  shutdown(): void { for (const l of this.live.values()) { this.ended.add(l.proc); l.proc.kill(); } }

  private forget(l: Hosted<E>): void { if (this.live.get(l.session) === l) this.live.delete(l.session); }

  /** The stream's facts: the runtime record, the runtime's own id for the session, the account's usage windows. */
  private facts(session: string, f: StreamFacts): void {
    const patch: Record<string, unknown> = {};
    if (f.model) patch.model = f.model;
    if (f.contextTokens !== undefined) patch.context_tokens = f.contextTokens;
    if (f.contextWindow) patch.context_window = f.contextWindow;
    if (this.record.cost && f.costUsd !== undefined) patch.cost_usd = f.costUsd;
    if (f.contextTokens !== undefined || (this.record.workingFromModel && f.model)) patch.state = "working";
    if (f.saved !== undefined && this.store.readRuntime(session)?.conversation_saved !== f.saved) patch.conversation_saved = f.saved;
    if (f.pid !== undefined) patch.pid = f.pid;
    if (Object.keys(patch).length) this.write(session, patch);
    // Every session's usage windows count (one subscription; decided with ST1 on 2026-11-14).
    if (f.usage) writeUsage({ updated_at: now(), windows: { ...readUsage()?.windows, ...f.usage } });
    if (f.nativeId) {
      const s = this.store.readSession(session);
      if (s.native_id !== f.nativeId) this.store.writeSession({ ...s, native_id: f.nativeId });
    }
  }

  /** The account's usage windows of a runtime as the server knows them now (usage.json), or none. */
  private windows(runtime: SessionFile["runtime"]): TurnRecord["windows_start"] {
    const all = Object.entries(readUsage()?.windows ?? {}).filter(([k]) => (runtime === "codex") === k.startsWith("codex_"));
    return all.length ? Object.fromEntries(all.map(([k, w]) => [k, { utilization: w.utilization, resets_at: w.resets_at }])) : undefined;
  }

  /**
   * One line in <NEXUS_HOME>/turns.jsonl for a turn that ended (`end`) or whose process ended first (none:
   * interrupted). A failure to write is no failure of the turn.
   */
  private recordTurn(session: SessionFile, turn: OpenTurn, model: string | undefined, end: AgentEvents["turnEnd"][0] | undefined): void {
    if (session.runtime === "external" || session.role === "user") return;
    try {
      const s = this.store.readSession(session.id);
      const at = now();
      appendTurn({
        v: 1, at, started_at: turn.started, duration_ms: Math.round(performance.now() - turn.startedMs),
        project: s.project, session: s.id, role: s.role as TurnRecord["role"], runtime: s.runtime as TurnRecord["runtime"],
        model: model ?? s.model ?? undefined, effort: s.effort ?? undefined, ...turn.tag, tags: this.tagsOf(turn.tag),
        outcome: !end ? "interrupted" : end.ok ? "ok" : end.failure ? end.failure.kind : "interrupted",
        failure: end?.failure?.code,
        tokens: tokenCounts(end?.tokens),
        subagent_tokens: tokenCounts(end?.subagentTokens),
        cost_usd: end?.costUsd,
        windows_start: turn.windows, windows_end: this.windows(s.runtime),
      });
    } catch (e) { console.error(`turns.jsonl: ${(e as Error).message}`); }
  }

  /** The tags of the step a turn works on, as planned now (tags.ts, stepTags); none for a turn without a step. */
  private tagsOf(at: OpenTurn["tag"]): TurnRecord["tags"] {
    if (!at.queue || !at.step) return undefined;
    try {
      const q = this.store.readQueue(at.queue);
      const step = stepDefs(q).find((x) => x.id === at.step);
      if (!step) return undefined;
      const tags = stepTags(step, q, this.store.readTags());
      return Object.keys(tags).length ? tags : undefined;
    } catch { return undefined; }
  }

  /** Changes the session's runtime record (one writer: the server). */
  write(session: string, patch: Record<string, unknown>): void {
    const old = this.store.readRuntime(session);
    this.store.writeRuntime(session, { turns: 0, state: "idle", ...old, ...patch, updated_at: now() } as never);
  }
}

// AgentHost: starts the agent processes of one role (workers, the orchestrator, thinking partners), one per session,
// and keeps what every role keeps the same way: the session's runtime record (sessions/<id>/runtime.json), the facts
// read from the runtime's stream (the record, the runtime's own session id, the account's usage windows), and ending a
// process so that the session's next message starts a new one. What a role does with its agent's texts, turns and
// exits stays with the role: it gives its handlers when it starts a process.
import {
  appendTurn, now, readUsage, writeUsage, type ProjectStore, type SessionFile, type TurnRecord,
} from "@nexus/protocol";
import type { ActivityItem, AgentEvents, AgentProcess, RefusalItem, StreamFacts } from "./agent.ts";
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
} as const satisfies Record<string, RoleRecord>;

/** Which runtime to start, with its options. */
export type Launch = { runtime: "claude"; options: ClaudeOptions } | { runtime: "codex"; options: CodexOptions };

/** A role's handlers for its process's events; each runs after AgentHost has kept its records. */
export interface HostHandlers {
  message?(text: string): void;
  activity?(a: ActivityItem): void;
  refusal?(r: RefusalItem): void;
  facts?(f: StreamFacts): void;
  turnEnd?(end: AgentEvents["turnEnd"][0]): void;
  /** `byNexus`: the process was ended through AgentHost (retire, close, restartAfterTurn, shutdown). */
  exit?(code: number | null, byNexus: boolean): void;
  /** The queue and step a turn works on, for its record (a worker's run); asked when the turn begins. */
  tag?(): { queue?: string; step?: string };
}

/** A turn in progress, for its record: when it began, the windows then, what it works on. */
interface OpenTurn { started: string; windows?: TurnRecord["windows_start"]; tag: { queue?: string; step?: string } }

/** A session's running process, with what the role keeps beside it (`E`). */
export type Hosted<E extends object = object> = { readonly session: string; readonly proc: AgentProcess } & E;

export interface AgentHostOptions {
  /** Makes the process; tests give a stand-in. By default a ClaudeSession or a CodexSession. */
  spawn?: (launch: Launch) => AgentProcess;
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
  private readonly live = new Map<string, Hosted<E>>();
  /** What each process was started with, to tell when the settings changed since (stale). */
  private readonly launched = new WeakMap<AgentProcess, Launch>();
  /** Processes ended through AgentHost: their exit is no failure. */
  private readonly ended = new WeakSet<AgentProcess>();
  /** Processes to end when their running turn ends. */
  private readonly afterTurn = new WeakSet<AgentProcess>();

  constructor(store: ProjectStore, record: RoleRecord, options: AgentHostOptions = {}) {
    this.store = store;
    this.record = record;
    this.spawn = options.spawn ?? spawnRuntime;
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

  /** The processes as last started, by session. */
  all(): Hosted<E>[] { return [...this.live.values()]; }

  /** No process is in the middle of a turn. */
  idle(): boolean { return !this.all().some((l) => l.proc.state === "working"); }

  /** A process is still running (after shutdown: not yet exited). */
  alive(): boolean { return this.all().some((l) => l.proc.state !== "exited"); }

  /**
   * Starts a process for the session. `launch` gets whether the runtime resumes the session (it ran before: it has a
   * runtime record) and says what to start; `handlers` get the hosted entry, with the role's own `extra` fields.
   */
  start(session: SessionFile, launch: (resume: boolean) => Launch, extra: E, handlers: (l: Hosted<E>) => HostHandlers): Hosted<E> {
    const resume = this.store.readRuntime(session.id) !== undefined;
    const how = launch(resume);
    const proc = this.spawn(how);
    const l = { ...extra, session: session.id, proc } as Hosted<E>;
    this.live.set(session.id, l);
    this.launched.set(proc, how);
    this.write(session.id, { state: "idle", pid: proc.pid });
    const on = handlers(l);
    // The per-turn record (turns.jsonl): a turn begins with the runtime's turn start, or else with the first thing it
    // streams after the previous turn's end.
    let open: OpenTurn | undefined;
    let model: string | undefined;
    const begin = () => { open ??= { started: now(), windows: this.windows(session.runtime), tag: on.tag?.() ?? {} }; };
    proc.on("message", (text) => { begin(); on.message?.(text); });
    // Not an error line: a process that exits writes one after its last turn, and that is no new turn.
    proc.on("activity", (a) => { if (a.kind !== "error") begin(); on.activity?.(a); });
    proc.on("refusal", (r) => on.refusal?.(r));
    proc.on("facts", (f) => {
      if (f.model) model = f.model;
      if (f.contextTokens !== undefined) begin();
      this.facts(session.id, f); on.facts?.(f);
    });
    proc.on("turnEnd", (end) => {
      begin();
      this.recordTurn(session, open!, model, end);
      open = undefined;
      this.write(session.id, this.record.countTurns ? { state: "idle", turns: (this.store.readRuntime(session.id)?.turns ?? 0) + 1 } : { state: "idle" });
      if (this.afterTurn.has(proc)) { this.afterTurn.delete(proc); this.ended.add(proc); proc.kill(); this.forget(l); }
      on.turnEnd?.(end);
    });
    proc.on("exit", (code) => {
      // A turn its process did not finish (a kill, an update's drain, a crash): recorded as interrupted.
      if (open) { this.recordTurn(session, open, model, undefined); open = undefined; }
      this.write(session.id, { state: "exited" });
      this.forget(l);
      on.exit?.(code, this.ended.has(proc));
    });
    return l;
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
   * an idle one now.
   */
  restartAfterTurn(session: string): void {
    const l = this.running(session);
    if (!l) return;
    if (l.proc.state === "working") { this.afterTurn.add(l.proc); return; }
    this.ended.add(l.proc);
    l.proc.kill();
    this.live.delete(session);
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
        v: 1, at, started_at: turn.started, duration_ms: Math.max(0, Date.parse(at) - Date.parse(turn.started)),
        project: s.project, session: s.id, role: s.role as TurnRecord["role"], runtime: s.runtime as TurnRecord["runtime"],
        model: model ?? s.model ?? undefined, effort: s.effort ?? undefined, ...turn.tag,
        outcome: !end ? "interrupted" : end.ok ? "ok" : end.failure ? end.failure.kind : "interrupted",
        failure: end?.failure?.code,
        tokens: end?.tokens ? { input: end.tokens.input, output: end.tokens.output, cache_read: end.tokens.cacheRead, cache_creation: end.tokens.cacheCreation } : undefined,
        cost_usd: end?.costUsd,
        windows_start: turn.windows, windows_end: this.windows(s.runtime),
      });
    } catch (e) { console.error(`turns.jsonl: ${(e as Error).message}`); }
  }

  /** Changes the session's runtime record (one writer: the server). */
  write(session: string, patch: Record<string, unknown>): void {
    const old = this.store.readRuntime(session);
    this.store.writeRuntime(session, { turns: 0, state: "idle", ...old, ...patch, updated_at: now() } as never);
  }
}

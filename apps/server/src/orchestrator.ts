// The project's orchestrator: a conversation on Claude Code or Codex, with optional usage fallback. It plans
// queues and launches runs through `nexus` (queue.drafted, session.request), answers or escalates workers'
// questions, and is told when a worker asks or a run halts or finishes. It may read everything and write only queue
// drafts under .nexus/drafts/: permission mode dontAsk with a read-only allow list plus the drafts rules.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActionError, DEFAULT_ORCHESTRATOR_CONTEXT_TOKENS, Effort, acceptedByNexus, contextLimit, acceptedOn, normPath, effortIssue, type ProjectFile, reviewedByOrchestrator, runGoing, ProjectStore, applyDraft, defineMetric, inPlan, loadProjectState, metricDef, openPlan, orchestratorOverview, overThreshold, proposePlan, proposeTags, readAway, readUsage, orchestratorStatusChange, newId, now, sendBack, type Applied, type Event, type EventType, type NotifyKind, type ProjectState, type QueueView, type SessionFile, type SessionView, type StepView,
} from "@nexus/protocol";
import type { AgentProcess } from "./agent.ts";
import type { CodexPermissions } from "./codex.ts";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Hosted, type Launch } from "./agent-host.ts";
import type { Engine } from "./engine.ts";
import { orchestratorAgentsFile } from "./helpers.ts";
import { RESTARTED, STOPPED, chatView } from "./chats.ts";
import type { UpdateNotice } from "./lifecycle.ts";
import { describeDeployChanges, type DeployChanges } from "./deploy.ts";
import type { CrashRecord } from "./crash.ts";
import type { PlanNotice } from "./deploy-plan.ts";
import {
  acceptedNoteNotice, approvalNotice, checkAcceptedNotice, checkDecisionNotice, checkNotCommandNotice, cleanupWaitNotice, discardNotice, liftNotice, mergedNotice, mergeWaitNotice, missedStartNotice, noticeText, orchestratorBriefing, pausedNotice,
  carriedMessages, formatInbox, orchestratorFreshSeed, orchestratorRuntimeSeed, orchestratorSummaryRequest, summaryLists, tokenText, questionNotice, rejectionNotice, restartedNotice, fixAskedNotice, levelToUserNotice, reviewNotice, awayOnNotice, awayEndNotice, awayStuckNotice, planDecisionNotice, planHeldNotice, runEndNotice, maintenanceFindingsNotice, staticAnalysisNotice, serverCrashNotice, stepNoteNotice, tagDecisionNotice, fallbackNotice, metricNotice, userMessage, withdrawalNotice,
} from "./prompts.ts";
import { shellRules } from "./shell-rules.ts";
import { ReviewHelpers, audited, type HelperOptions } from "./review-helper.ts";

// Agent (formerly Task) lets it call subagents; they run within these same read-only permissions.
const READ_ONLY_TOOLS = [
  "Read", "Grep", "Glob", "Agent", "Task",
  ...shellRules(["nexus", "git log", "git status", "git diff", "git show", "git branch", "git worktree list"]),
];
// Queue drafts are files it writes and then hands to `nexus queue draft`: a long heredoc breaks in Claude Code's
// shell wrapper on Windows. Edit and Write stay out of NEVER because a disallow rule beats these path rules;
// dontAsk refuses writes anywhere else.
const DRAFTS = ".nexus/drafts";
const DRAFT_TOOLS = [`Write(${DRAFTS}/**)`, `Edit(${DRAFTS}/**)`];
const NEVER = ["NotebookEdit", "MultiEdit"];

/** The runtimes the orchestrator runs on: its setting's `codex`, else Claude Code (`external` has no process). */
type OrchestratorRuntime = "claude" | "codex";
type Target = { runtime: OrchestratorRuntime; model?: string; effort?: Effort };
const RUNTIME_NAMES: Record<OrchestratorRuntime, string> = { claude: "Claude Code", codex: "Codex" };
const runtimeOf = (p: ProjectFile): OrchestratorRuntime => (p.orchestrator?.runtime === "codex" ? "codex" : "claude");

/**
 * The orchestrator's sandbox on Codex (decided by the user 2026-11-16, queue OC1): a permission profile that reads
 * everything and writes only the drafts folder and the session's own events.jsonl, the one file the nexus CLI writes
 * for it (Codex sandboxes every command, the CLI's too). Not its session.yaml (its role), not its inbox, nothing of
 * the user's. Paths with forward slashes, as probed.
 */
function orchestratorPermissions(nexusDir: string, session: string): CodexPermissions {
  const path = (...p: string[]) => join(nexusDir, ...p).replaceAll("\\", "/");
  return { name: "nexus_orchestrator", extends: ":read-only", filesystem: { [path("drafts")]: "write", [path("sessions", session, "events.jsonl")]: "write" } };
}

/** The orchestrator's events the server carries out (applyRequests), each once, its outcome in applied.jsonl. */
const REQUESTS: ReadonlySet<EventType> = new Set(["queue.drafted", "session.request", "status.set", "review.sent_back", "plan.proposed", "tags.proposed", "metric.defined", "recurring.set", "static_analysis.declined"]);

/**
 * The orchestrator's context care (contextCare), recorded in its session's applied.jsonl: the request for its summary
 * (the message: the context fill then, 0 to 1; `tokens`: its context tokens), and the context tokens of a fresh session
 * at the end of its first turn.
 */
const SUMMARY_ASKED = "context:asked";
const FIRST_FILL = "context:first";
/** A context fill (0 to 1) in whole percent. */
const pct = (fill: number) => Math.round(fill * 100);
/** How many chat entries the view sends: the current session's newest, and then the earlier sessions' of its line. */
const VIEW_ENTRIES = 300;
/** The earlier sessions' entries the view sends at least, however long the current session's chat. */
const EARLIER_MIN = 60;

/** A summary an orchestrator session wrote for the fresh one that went on from it (a context.summary event). */
type Summary = NonNullable<SessionView["context"]>;

/**
 * A session the current orchestrator session went on from (context care), as the chat view sends it: its newest
 * entries, and its switch to the next: when, its context fill then (0 to 1) and its tokens (unknown before queue CT: null),
 * and the summary it wrote (none: null).
 */
interface EarlierSession {
  session: string;
  created_at: string;
  chat: ReturnType<typeof chatView>["chat"];
  switch: { at: string; fill: number | null; tokens: number | null; summary: Summary | null };
}

/** Who accepted a step, as the orchestrator's notices list it (queue RH, H9). */
function acceptedBy(a: NonNullable<StepView["accepted"]>): string {
  if (a.by === "helper") return `accepted by the review helper (${acceptedOn(a)})`;
  if (a.by === "nexus") return "accepted by Nexus, a clean merge without a model";
  return `accepted by the ${a.by}`;
}

/** A push notification for the user's devices (src/remote.ts `push`). */
export interface UserNotice { title: string; body: string; url: string; tag: string; kind: NotifyKind }

/** Where its news about Nexus itself comes from (Orchestrator.news), and how a notice reaches the user's devices. */
interface News {
  update?: () => UpdateNotice | undefined;
  plan?: () => PlanNotice[];
  changes?: () => DeployChanges[];
  crash?: () => CrashRecord | undefined;
  push?: (n: UserNotice) => void;
}

export class Orchestrator {
  private readonly host: AgentHost;
  private readonly store: ProjectStore;
  private readonly engine: Engine;
  private readonly changed: () => void;
  /** Wakes the notices held while the orchestrator's runtime is beyond the usage threshold (runtimeFull). */
  private heldTimer: NodeJS.Timeout | undefined;
  private heldUntil: number | undefined;
  private readonly nowMs: () => number;
  private handling = false;
  private applying = false;
  /**
   * News about Nexus itself: the outcome of an update, for the session that asked for it (src/lifecycle.ts), and the
   * changes for agents of each deploy, for every session older than it (src/deploy.ts), and the server's last crash
   * (src/crash.ts), for every session older than it too.
   */
  private stopped = false;
  private readonly news: Required<Omit<News, "push">> & Pick<News, "push">;
  /**
   * The review helpers (queue RH, src/review-helper.ts), which take its routine reviews; they run before its notices.
   * Without them (`host.helpers` not given, as in most tests) the orchestrator reviews every step itself.
   */
  private readonly helpers?: ReviewHelpers;

  /** `host`: how its process is made (tests give a stand-in); `helpers`: the review helpers' options, when they run. */
  constructor(store: ProjectStore, engine: Engine, changed: () => void, news: News = {}, host: AgentHostOptions & { nowMs?: () => number; helpers?: HelperOptions } = {}) {
    this.store = store;
    this.engine = engine;
    this.changed = changed;
    this.news = { update: news.update ?? (() => undefined), plan: news.plan ?? (() => []), changes: news.changes ?? (() => []), crash: news.crash ?? (() => undefined), push: news.push };
    this.host = new AgentHost(store, ROLE_RECORDS.orchestrator, host);
    this.nowMs = host.nowMs ?? Date.now;
    if (host.helpers) this.helpers = new ReviewHelpers(store, changed, () => engine.draining, host.helpers);
  }

  /** The orchestrator's hosted process (one at a time): the latest one started, until it exits or Nexus ends it. */
  private get hosted(): Hosted | undefined { return this.host.all()[0]; }
  private get proc(): AgentProcess | undefined { return this.hosted?.proc; }

  /** The current orchestrator session, if one was ever started. */
  session(): SessionFile | undefined {
    return this.sessionFile(this.store.readProject().orchestrator?.session);
  }

  /** A session's file, if there is one. */
  private sessionFile(id: string | null | undefined): SessionFile | undefined {
    if (!id) return undefined;
    try { return this.store.readSession(id); } catch { return undefined; }
  }

  view() {
    const s = this.session();
    const o = this.store.readProject().orchestrator;
    // The newest 300 entries with their lines, and the session's pins (chats.ts); a fresh session has none.
    const own = s ? chatView(this.store, s.id, VIEW_ENTRIES) : { chat: [], pins: [] };
    return {
      session: s ?? null,
      model: s ? s.model ?? null : o?.model ?? null,
      effort: s ? s.effort ?? null : o?.effort ?? null,
      state: this.proc?.state ?? "exited",
      runtime: s ? this.store.readRuntime(s.id) ?? null : null,
      ...own,
      earlier: s ? this.earlier(s, own.chat.length) : [],
    };
  }

  /**
   * The sessions the current one went on from (context care), oldest first, each with the newest entries of its chat
   * and how it ended: the dashboard shows them above the current chat, one chat with a line at each switch. They get
   * what the view has room for after the current session's entries, at least EARLIER_MIN of them.
   */
  private earlier(s: SessionFile, shown: number): EarlierSession[] {
    let room = Math.max(EARLIER_MIN, VIEW_ENTRIES - shown);
    const out: EarlierSession[] = [];
    for (const x of this.lineage(s).slice(1)) {
      const chat = room > 0 ? chatView(this.store, x.id, room).chat : [];
      room -= chat.length;
      out.unshift({ session: x.id, created_at: x.created_at, chat, switch: this.switchOf(x) });
    }
    return out;
  }

  /** How a session went on in a fresh one: when, how full its context was, and the summary it wrote (if any). */
  private switchOf(old: SessionFile): EarlierSession["switch"] {
    const asked = this.summaryAsked(old);
    const summary = this.summaryWritten(old, asked) ?? null;
    const next = this.sessionFile(old.continued_by);
    return { at: next?.created_at ?? asked?.at ?? old.created_at, fill: asked ? Number(asked.message) : null, tokens: asked?.tokens ?? null, summary };
  }

  /** A message from the user in the chat. */
  say(text: unknown): void {
    if (typeof text !== "string" || !text.trim()) throw new ActionError("the message is empty");
    // While the session writes its summary for a fresh one, the message waits for the fresh session (its first turn).
    const current = this.ensure(false);
    if (this.summaryAsked(current) || (this.store.readProject().orchestrator?.fallback && this.runtimeFull(loadProjectState(this.store)))) {
      this.store.appendChat(current.id, { at: now(), from: "user", text: text.trim() });
      this.store.appendInbox(current.id, { v: 1, id: `say-${newId()}`, at: now(), from: "user", type: "message", text: text.trim() });
      this.changed();
      return;
    }
    const s = this.ensure();
    this.deliverPending(loadProjectState(this.store), s);
    this.store.appendChat(s.id, { at: now(), from: "user", text: text.trim() });
    // Changes for agents held while notices are off go in with this turn (and count as told only now).
    const held = this.pendingChanges(s);
    if (held.length) this.markTold(s, held.map((d) => d.key));
    this.deliver(userMessage(text.trim(), held.length ? describeDeployChanges(held) : undefined), [text.trim()]);
  }

  /** Durable direct idea delivery. Inbox first, then an idempotent visible chat row; the normal inbox path runs it. */
  enqueueIdea(id: string, text: string): { at: string; session: string; line: number; inbox: string } {
    const key = `idea-${id}`;
    // Search all historical orchestrator sessions too: a retry after a session switch must not enqueue again.
    let destination: { session: string; at: string } | undefined;
    for (const session of this.store.sessionIds()) {
      if (this.store.readSession(session).role !== "orchestrator") continue;
      const previous = this.store.readInbox(session).entries.find((m) => m.id === key);
      if (!previous) continue;
      if (previous.type !== "message" || previous.text !== text) throw new ActionError("Handoff identity already has another payload", 409);
      destination = { session, at: previous.at };
      break;
    }
    if (!destination) {
      const s = this.ensure(false);
      destination = { session: s.id, at: now() };
      this.store.appendInbox(s.id, { v: 1, id: key, at: destination.at, from: "user", type: "message", text });
    }
    let line = this.store.readChat(destination.session).entries.findIndex((c) => c.message_id === key);
    if (line < 0) {
      line = this.store.readChat(destination.session).entries.length;
      this.store.appendChat(destination.session, { at: destination.at, from: "user", text, message_id: key });
    }
    this.changed();
    return { ...destination, line, inbox: key };
  }

  /** Deploys whose changes for agents this session's lineage has not been told; none from before it started. */
  private pendingChanges(s: SessionFile): DeployChanges[] {
    const line = this.lineage(s);
    const told = new Set(line.flatMap((x) => this.store.readApplied(x.id).entries.map((a) => a.event)));
    return this.news.changes().filter((d) => d.at >= line.at(-1)!.created_at && d.changes.length && !told.has(d.key));
  }

  private markTold(s: SessionFile, keys: string[]): void {
    for (const k of keys) this.store.appendApplied(s.id, { at: now(), event: k, ok: true, message: "told" });
  }

  /**
   * The orchestrator's model and effort. They apply from the next message: the conversation goes on (resumed) in a
   * process started with them. An empty value means the runtime's default.
   */
  settings(model: unknown, effort: unknown): void {
    const m = typeof model === "string" && model.trim() ? model.trim() : undefined;
    const e = effort === undefined || effort === null || effort === "" ? undefined : Effort.safeParse(effort);
    if (e && !e.success) throw new ActionError(`effort is one of ${Effort.options.join(", ")}`);
    // By the runtime it runs on: Claude Code takes low to max; Codex checks its model's own levels.
    const issue = effortIssue(runtimeOf(this.store.readProject()), e?.data);
    if (issue) throw new ActionError(`the orchestrator runs on Claude Code: ${issue}`);
    this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null, ...p.orchestrator, model: m, effort: e?.data } }));
    const s = this.session();
    if (s && !s.orchestrator_fallback) this.store.writeSession({ ...s, model: m, effort: e?.data });
    // New settings wait for a running turn to end; the next message starts a process with them.
    const l = this.hosted;
    if (l) this.host.restartAfterTurn(l.session);
  }

  /**
   * The user's stop button (decided 2026-11-14, queue CH4): interrupts the running turn, a pure interrupt (the
   * runtime's control, not a message). The chat says "Stopped."; nothing the turn writes after that reaches it; the
   * process stays, idle; messages sent during the turn that it had not taken in go in with the next one.
   */
  stop(): void {
    const s = this.session();
    if (!s || !this.proc || !this.proc.stop()) throw new ActionError("the orchestrator is not working", 409);
    this.store.appendChat(s.id, { at: now(), from: "nexus", text: STOPPED });
    this.changed();
  }

  /** Ends the current orchestrator session and starts the next message in a new one (the old transcript stays). */
  reset(): void {
    const l = this.hosted;
    if (l) this.host.close(l.session);
    this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: null } }));
  }

  /** After every change: carry out the orchestrator's requests and tell it what it should know. */
  onChange(state: ProjectState): void {
    if (this.stopped || this.handling) return;
    this.handling = true;
    try { this.changedState(state); } finally { this.handling = false; }
  }

  private changedState(state: ProjectState): void {
    // The review helpers first: a step one of them takes is not also told to the orchestrator (queue RH).
    if (this.helpers?.onChange(state)) state = loadProjectState(this.store);
    let s = this.session();
    const notes = this.pendingNotes(state);
    if (!s) {
      // A step waiting for its review, or a note or rejection of the user's, starts it (after a reset, or before it ever ran).
      if (this.engine.draining || (!notes.length && !state.queues.some((q) => q.steps.some((st) => this.forOrchestrator(state, q, st))))) return;
      s = this.ensure(false);
    }
    this.applyRequests(s);
    if (this.engine.draining) return; // held until the update settles: told after its restart, or once it fails
    s = this.ensure(false);
    state = loadProjectState(this.store);
    if (state.project.orchestrator?.fallback && !this.summaryAsked(s) && this.runtimeFull(state)) {
      this.notify(state, s, state.project.orchestrator?.notify === false);
      return;
    }
    this.deliverPending(state, s);
    // Its summary for a fresh session asked for, or the switch made: what follows waits for the fresh session.
    if (this.contextCare(state, s)) return;
    // The user's notes on an acceptance are like chat messages of the user: told whatever notify says.
    for (const n of notes) {
      this.ensure();
      this.markTold(s, [n.key]);
      if (n.note) {
        this.store.appendDelivered(s.id, { at: now(), kind: "note", id: n.note, via: "turn" });
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: `Your note on step ${n.step} of queue ${n.queue}, in the orchestrator's review:\n${n.text}` });
        this.deliver(stepNoteNotice(n));
        continue;
      }
      if (n.discard) {
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You chose to discard the work of stopped step ${n.step} of queue ${n.queue} (${n.discard.length} commit${n.discard.length === 1 ? "" : "s"}). The stop stays until you approve a revision that reverts it.` });
        this.deliver(discardNotice(n, n.discard));
        continue;
      }
      if (n.fix) {
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You asked a fix of step ${n.step} of queue ${n.queue}, which the orchestrator accepted provisionally:
${n.text}` });
        this.deliver(fixAskedNotice({ queue: n.queue, step: n.step, text: n.text, done: n.last }));
        continue;
      }
      if (n.rejected) {
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You rejected step ${n.step} of queue ${n.queue}${n.text ? `:\n${n.text}` : "."}` });
        this.deliver(rejectionNotice(n));
        continue;
      }
      this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You accepted step ${n.step} of queue ${n.queue}${n.last ? " (its last step)" : ""} with a note for the orchestrator:\n${n.text}` });
      this.deliver(acceptedNoteNotice(n));
    }
    // With notices off it is still told the outcome of an update it ran itself: that answers its own command.
    this.notify(state, s, state.project.orchestrator?.notify === false);
    this.deliverAnswers(state, s);
  }

  /**
   * Notes of the user's on an acceptance, for the orchestrator, that no orchestrator session has been told yet (each
   * is told once per project: a reset does not repeat it, and one made with no session starts one).
   */
  private pendingNotes(state: ProjectState): { key: string; queue: string; step: string; text: string; last: boolean; rejected?: boolean; fix?: boolean; discard?: string[]; note?: string }[] {
    const out: { key: string; queue: string; step: string; text: string; last: boolean; rejected?: boolean; fix?: boolean; discard?: string[]; note?: string }[] = [];
    // The user's notes on a step the orchestrator held in review (picture comments on it too): told like a chat message.
    for (const q of state.queues) for (const st of q.steps) for (const n of st.notes) {
      if (n.to !== "orchestrator" || n.from !== "user") continue;
      out.push({ key: `notify:stepnote:${n.id}`, queue: q.id, step: st.id, text: n.body, last: false, note: n.id });
    }
    // The user's Discard of a stopped step's work (src/stopwork.ts): told like the user's chat message.
    for (const q of state.queues) q.changes.forEach((c, i) => {
      if (c.kind !== "work" || c.to !== "discarded" || !c.step) return;
      out.push({ key: `notify:discard:${q.id}:${i}`, queue: q.id, step: c.step, text: "", last: false, discard: c.commits ?? [] });
    });
    for (const q of state.queues) for (const st of q.steps) for (const e of st.timeline) {
      if (e.type === "review.rejected") {
        out.push({ key: `notify:reject:${e.id}`, queue: q.id, step: st.id, text: e.text ?? "", last: q.steps.at(-1)?.id === st.id, rejected: true });
        continue;
      }
      // The user's Fix it on a provisional acceptance: the orchestrator drafts the fix, whatever notify says.
      if (e.type === "review.fix_asked" && st.provisional?.fix?.at === e.at) {
        out.push({ key: `notify:fix:${e.id}`, queue: q.id, step: st.id, text: e.text, last: q.status === "done", fix: true });
        continue;
      }
      if (e.type !== "review.accepted" || e.to !== "orchestrator" || !e.text) continue;
      out.push({ key: `notify:note:${e.id}`, queue: q.id, step: st.id, text: e.text, last: q.steps.at(-1)?.id === st.id });
    }
    if (!out.length) return out;
    const told = new Set(state.sessions.filter((x) => x.role === "orchestrator").flatMap((x) => this.store.readApplied(x.id).entries.map((a) => a.event)));
    return out.filter((n) => !told.has(n.key));
  }

  /**
   * Before the hand-over to the next server (an update): a turn still running is cut off, and its session's record
   * keeps what it answered (AgentHost.cutOff). The next server goes on with it (resumeCutOff).
   */
  cutOff(): void { this.host.cutOff(); }

  /**
   * After a restart that cut off its turn (cutOff): the same session goes on, told what it was answering; the chat
   * says so in a line of its own.
   */
  resumeCutOff(): void {
    const s = this.session();
    const cut = s && this.host.interruption(s.id);
    if (!s || !cut) return;
    this.store.appendChat(s.id, { at: now(), from: "nexus", text: RESTARTED });
    if (this.store.readProject().orchestrator?.fallback) {
      // Keep the interrupted work durable when the restart finds a full runtime, or selects another one.
      const current = this.ensure(false);
      this.store.appendInbox(current.id, { v: 1, id: `say-${newId()}`, at: now(), from: "nexus", type: "message", text: restartedNotice(cut.asked) });
      this.host.resumed(s.id);
      this.changed();
      return;
    }
    this.ensure();
    this.deliver(restartedNotice(cut.asked), cut.asked);
    this.host.resumed(s.id);
  }

  /** For good: an orchestrator shut down starts no process again (a late change, an agent's exit, may still come in). */
  shutdown(): void { this.stopped = true; clearTimeout(this.heldTimer); this.host.shutdown(); this.helpers?.shutdown(); }

  /**
   * A step whose review notice the orchestrator gets: waiting for its review, and not the integration step Nexus accepts
   * itself (queue MI). With review helpers on (queue RH), only once the step is passed on: one a helper has, or will take
   * at the next change (the state read here may be newer than the one the helpers saw), is not the orchestrator's yet.
   */
  private forOrchestrator(state: ProjectState, q: QueueView, st: StepView): boolean {
    if (!reviewedByOrchestrator(st) || acceptedByNexus(q, st)) return false;
    if (st.helper) return st.helper.state === "passed_on";
    return !this.helpers?.takes(state);
  }

  /** Its process, or a review helper's, is still running (after shutdown: not yet exited). */
  alive(): boolean { return (!!this.proc && this.proc.state !== "exited") || !!this.helpers?.alive(); }

  /**
   * Not in the middle of a turn, nor in the moment after one in which the runtime may still start a turn of its own
   * (AgentProcess.settling): what waits for its idleness (a runtime switch, a restart on changed settings) is looked at
   * again on `settled`.
   */
  idle(): boolean { return !this.proc || (this.proc.state !== "working" && !this.proc.settling); }

  // ---------------------------------------------------------------- the session

  private ensure(start = true): SessionFile {
    let s = this.session();
    const project = this.store.readProject();
    if (!s) {
      s = this.newSession(project);
      this.store.writeSession(s);
      const id = s.id;
      this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: id } }));
    }
    if (this.idle()) s = this.route(s, project);
    if (!start) return s;
    // Settings it was started with changed since (its model or effort, global or the project's own; a threshold its
    // briefing names): a new process from this message on (a working one ends after its turn, and this message goes
    // into that turn), resuming the conversation; an idle one ends now (retireStale).
    if (this.proc?.state === "working" && this.host.stale(s.id, this.launcher(s))) this.host.restartAfterTurn(s.id);
    else this.retireStale(s);
    if (!this.proc || this.proc.state === "exited") this.spawn(s);
    return s;
  }

  /** The active target is frozen during a turn; a fallback never changes the user's primary settings. */
  private target(s: SessionFile): Target {
    const p = this.store.readProject();
    if (s.orchestrator_fallback) return s.orchestrator_fallback.target;
    return s.runtime === runtimeOf(p)
      ? { runtime: runtimeOf(p), model: p.orchestrator?.model, effort: p.orchestrator?.effort }
      : { runtime: s.runtime === "codex" ? "codex" : "claude", model: s.model, effort: s.effort };
  }

  /** Select only between turns. A persisted reset deadline prevents bouncing on stale/lower usage readings. */
  private route(s: SessionFile, p: ProjectFile): SessionFile {
    const primary: Target = { runtime: runtimeOf(p), model: p.orchestrator?.model, effort: p.orchestrator?.effort };
    const fallback = p.orchestrator?.fallback;
    const settings = JSON.stringify([primary, fallback]);
    const windows = readUsage()?.windows ?? {};
    const full = (runtime: OrchestratorRuntime) => overThreshold(runtime, windows, p.defaults.usage_pause_threshold, this.nowMs());
    const busy = full(primary.runtime);
    const previous = s.orchestrator_fallback;
    let active = previous?.settings === settings ? previous : undefined;
    if (active && this.nowMs() >= Date.parse(active.until) && !busy) active = undefined;
    if (active && busy && Date.parse(busy.until) > Date.parse(active.until)) active = { ...active, ...busy };
    if (!active && busy && fallback && !full(fallback.runtime)) active = { settings, ...busy, target: fallback };
    const target = active?.target ?? primary;
    this.wakeAt([busy?.until, fallback && full(fallback.runtime)?.until, active?.until]);
    const switched = !!active !== !!previous || (!!active && active.settings !== previous?.settings);
    const reason = switched ? active
      ? `The orchestrator switches to its fallback, ${RUNTIME_NAMES[target.runtime]}${target.model ? ` (${target.model})` : ""}: ${active.reason}; resets at ${active.until}.`
      : `The orchestrator returns to its primary, ${RUNTIME_NAMES[primary.runtime]}${primary.model ? ` (${primary.model})` : ""}: ${previous?.settings === settings ? "the primary usage window has reset" : "its settings changed"}.`
      : undefined;
    if (s.runtime !== target.runtime && (!this.summaryAsked(s) || reason)) {
      return this.switchRuntime(s, target, active, reason);
    }
    if (JSON.stringify(previous) !== JSON.stringify(active)) {
      s = { ...s, orchestrator_fallback: active };
      this.store.writeSession(s);
      if (reason) this.store.appendChat(s.id, { at: now(), from: "nexus", text: reason });
    }
    return s;
  }

  /** Wake for the earliest relevant reset, including while the fallback is free and has no pending notices. */
  private wakeAt(times: (string | undefined)[]): void {
    const future = times.filter((t): t is string => !!t).map(Date.parse).filter((t) => t > this.nowMs());
    const until = future.length ? Math.min(...future) : undefined;
    if (until === this.heldUntil) return;
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    this.heldUntil = until;
    if (until === undefined || this.stopped) return;
    const ms = Math.min(Math.max(until - this.nowMs() + 1000, 1000), 2 ** 31 - 1);
    this.heldTimer = setTimeout(() => {
      this.heldTimer = undefined; this.heldUntil = undefined;
      if (!this.stopped) this.changed();
    }, ms);
  }

  /** User messages held for a quota reset, and durable first prompts of a new runtime session. */
  private deliverPending(state: ProjectState, s: SessionFile): void {
    if (this.summaryAsked(s) || this.runtimeFull(state)) return;
    const pending = (state.sessions.find((x) => x.id === s.id)?.inbox ?? [])
      .filter((m) => m.type === "message" && !m.read_at && (m.id.startsWith("say-") || m.id.startsWith("runtime-seed-") || m.id.startsWith("idea-")));
    if (!pending.length) return;
    this.ensure();
    for (const m of pending) {
      this.store.appendDelivered(s.id, { at: now(), kind: "inbox", id: m.id, via: "turn" });
    }
    const held = this.pendingChanges(s);
    if (held.length) this.markTold(s, held.map((d) => d.key));
    this.deliver([
      ...pending.map((m) => m.from === "nexus" ? m.text : userMessage(m.text!)),
      ...(held.length ? [describeDeployChanges(held)] : []),
    ].join("\n\n"));
  }

  /**
   * A new orchestrator session on the runtime the project's settings name now. Claude Code's session id is chosen
   * here; a Codex thread's id comes from Codex once it starts (facts `nativeId`).
   */
  private newSession(project: ProjectFile, more: Partial<SessionFile> = {}): SessionFile {
    const runtime = more.runtime === "codex" ? "codex" : more.runtime === "claude" ? "claude" : runtimeOf(project);
    return {
      protocol: 1, id: newId(), project: project.id, role: "orchestrator", runtime, native_id: runtime === "claude" ? randomUUID() : null,
      title: "Orchestrator", cwd: project.root, launched_by: "nexus", created_at: now(),
      model: project.orchestrator?.model, effort: project.orchestrator?.effort, ...more,
    };
  }

  /**
   * The user changed the orchestrator's runtime (queue OC): a conversation cannot move between Claude Code and Codex,
   * so a fresh session goes on from `old` on `runtime`, from its briefing and the project's state (nexus status), with
   * the messages `old` had not read. `old` stays in the line (continues), so the dashboard shows its chat above the
   * new one. Its first message is kept in the new inbox until its runtime can receive it.
   */
  private switchRuntime(old: SessionFile, target: Target, fallback: SessionFile["orchestrator_fallback"], reason?: string): SessionFile {
    const state = loadProjectState(this.store);
    const unread = (state.sessions.find((x) => x.id === old.id)?.inbox ?? []).filter((m) => !m.read_at && !m.id.startsWith("notice-"));
    const project = this.store.readProject();
    const fresh = this.newSession(project, { continues: old.id, ...target, model: target.model, effort: target.effort, orchestrator_fallback: fallback });
    const summary = this.lineage(old).map((s) => this.summaryWritten(s)).find((x) => x !== undefined);
    if (summary) this.store.writeOrchestratorSummary(`# Orchestrator summary\n\nCarried from the previous orchestrator at ${summary.at}. The fresh session ${fresh.id} starts from it.\n\n${summary.text}\n${summaryLists(summary).join("\n")}\n`);
    this.store.writeSession(fresh);
    const from = RUNTIME_NAMES[old.runtime === "codex" ? "codex" : "claude"], to = RUNTIME_NAMES[target.runtime];
    const status = `project ${state.project.name} (${state.project.id})\n${orchestratorOverview(state)}`;
    const seed = orchestratorRuntimeSeed(from, to, status, carriedMessages(unread.map((m) => formatInbox(m, state))), summary, reason);
    this.store.appendInbox(fresh.id, { v: 1, id: `runtime-seed-${fresh.id}`, at: now(), from: "nexus", type: "message", text: seed });
    this.store.writeSession({ ...this.store.readSession(old.id), continued_by: fresh.id });
    for (const m of unread) this.store.appendDelivered(old.id, { at: now(), kind: "inbox", id: m.id, via: "carried", to: fresh.id });
    const l = this.hosted;
    if (l) this.host.close(l.session);
    this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: fresh.id } }));
    this.store.appendChat(old.id, { at: now(), from: "nexus", text: `The orchestrator goes on on ${to} in a fresh session (${fresh.id}): ${reason ?? "its runtime setting changed."}` });
    this.store.appendChat(fresh.id, { at: now(), from: "nexus", text: reason ?? `A fresh orchestrator session on ${to}: you switched it from ${from}. A conversation cannot move between the two, so it starts from its current briefing and nexus status; the earlier chat stays above.` });
    this.store.appendChat(fresh.id, { at: now(), from: "nexus", text: summary ? "It starts with the latest context summary (.nexus/orchestrator/summary.md), its current briefing and nexus status." : "No context summary was available; it starts with its current briefing and nexus status." });
    return fresh;
  }

  /**
   * How its process is started, from the project's effective settings now (the orchestrator's model and effort), on
   * the session's runtime. An effort Claude Code does not take (one set for Codex) is left out: Claude Code's default.
   */
  private launcher(s: SessionFile): (resume: boolean) => Launch {
    const project = this.store.readProject();
    const o = project.orchestrator;
    const runtime: OrchestratorRuntime = s.runtime === "codex" ? "codex" : "claude";
    const { model, effort: wanted } = this.target(s);
    const effort = effortIssue(runtime, wanted) ? undefined : wanted;
    const briefing = orchestratorBriefing(project.name, project.defaults.context_reuse_tokens, project.languages, o?.context_threshold_tokens ?? DEFAULT_ORCHESTRATOR_CONTEXT_TOKENS, runtime);
    const env = this.host.env(s.id);
    if (runtime === "codex") {
      // Its working directory is the project's root, which its sandbox keeps read-only (orchestratorPermissions). The
      // user's MCP servers, plugins and apps are off, every one (they run outside the sandbox and reach the Nexus
      // API; runtimes.codex.mcp_servers is the workers' only); no web search, as on Claude Code.
      return (resume) => ({ runtime: "codex", options: {
        cwd: s.cwd, model, effort, instructions: briefing, env,
        threadId: resume ? this.sessionFile(s.id)?.native_id ?? null : null,
        sandbox: "read-only", writableRoots: [], permissions: orchestratorPermissions(this.store.dir, s.id), approvalPolicy: "never",
        config: { web_search: "disabled" }, withoutUserTools: true,
      } });
    }
    return (resume) => ({ runtime: "claude", options: {
      cwd: s.cwd, uuid: s.native_id!, resume, model, effort,
      permissionMode: "dontAsk",
      allowedTools: [...READ_ONLY_TOOLS, ...DRAFT_TOOLS],
      disallowedTools: NEVER,
      appendSystemPrompt: briefing,
      agentsFile: orchestratorAgentsFile(),
      env,
    } });
  }

  /**
   * An idle process started with other settings than the project's now ends. A settling one is not idle: a turn of its
   * own may still start, and ending it would cut that off; a message goes to it, and its settling's end (`settled`) or
   * the next message looks again.
   */
  private retireStale(s = this.session()): void {
    if (s && this.proc && this.proc.state !== "exited" && this.idle() && this.host.stale(s.id, this.launcher(s))) this.host.retire(s.id);
  }

  private spawn(s: SessionFile): void {
    // Its session records the model and effort it runs on (the project's effective ones).
    const o = this.target(s);
    if (o && (o.model !== s.model || o.effort !== s.effort)) this.store.writeSession({ ...s, model: o.model, effort: o.effort });
    // On Codex its sandbox grants its paths as they are when the sandbox starts, so both are there first: its
    // events.jsonl (empty: the session alone writes its events, through nexus) and the drafts folder, which a project
    // may not have yet and the sandbox cannot make (probed, OC2: "Failed to create parent directories").
    if (s.runtime === "codex") {
      const events = join(this.store.sessionDir(s.id), "events.jsonl");
      if (!existsSync(events)) writeFileSync(events, "");
      mkdirSync(join(this.store.dir, "drafts"), { recursive: true });
    }
    const dropped = o?.effort && effortIssue(s.runtime === "codex" ? "codex" : "claude", o.effort);
    if (dropped) this.store.appendChat(s.id, { at: now(), from: "nexus", text: `The orchestrator's effort ${o.effort} is not one Claude Code takes (${dropped}): it runs at Claude Code's default.` });
    this.host.start(s, this.launcher(s), {}, () => ({
      // The chat gets the orchestrator's texts whole; the activity log keeps them clipped.
      message: (text) => this.store.appendChat(s.id, { at: now(), from: "orchestrator", text }),
      activity: (a) => {
        if (a.kind === "tool") this.store.appendChat(s.id, { at: now(), from: "orchestrator", kind: "tool", text: a.text });
        else if (a.kind === "error" || (a.kind === "turn_end" && a.text.includes("error"))) this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: a.text });
        this.store.appendActivity(s.id, { at: now(), ...a });
      },
      turnEnd: () => this.changed(),
      settled: () => { this.retireStale(); this.changed(); },
      exit: () => this.changed(),
    }));
  }

  /**
   * Sends to its process: into the running turn, else as a turn of its own. `quote`: what the turn answers, should a
   * restart cut it off (by default the text itself; a cut-off turn's own quotes when it goes on, so they never nest).
   */
  private deliver(text: string, quote: readonly string[] = [text]): void {
    this.host.send(this.hosted!, text, { quote });
    this.changed();
  }

  // ---------------------------------------------------------------- context care: a fresh session with a summary

  /** The session and those it went on from (context care), newest first. */
  private lineage(s: SessionFile): SessionFile[] {
    const out = [s];
    for (let x = s; x.continues && !out.some((y) => y.id === x.continues);) {
      try { x = this.store.readSession(x.continues); } catch { break; }
      out.push(x);
    }
    return out;
  }

  /** The request for the session's summary, if Nexus made it (it then goes on in a fresh session). */
  private summaryAsked(s: SessionFile): Applied | undefined {
    return this.store.readApplied(s.id).entries.find((a) => a.event === SUMMARY_ASKED);
  }

  /** The summary the session wrote once Nexus asked for it (`asked`): its last context.summary since, if any. */
  private summaryWritten(s: SessionFile, asked?: Applied): Summary | undefined {
    const e = this.store.readEvents(s.id).entries.filter((x) => x.type === "context.summary" && (!asked || x.at >= asked.at)).at(-1);
    return e?.type === "context.summary" ? { text: e.text, topics: e.topics, files: e.files, at: e.at } : undefined;
  }

  /**
   * The orchestrator's context care (decided by the user on 2026-11-15, queue CC): it is not compacted; it goes on in a
   * fresh session started from a summary it writes on purpose. When its context is beyond its threshold
   * (orchestrator.context_threshold_tokens, at most 80 % of its model's window: contextLimit; an unknown window, never)
   * at the end of a turn, its process idle and not settling, it is asked once for that summary (with `nexus context`);
   * once that turn is over, a fresh session goes on from it (goOnFresh). Meanwhile
   * notices, notes and the user's messages wait for the fresh session. A fresh session already that full at the end of
   * its first turn is not switched again: another would be no emptier. True: what else this change would tell it waits.
   */
  private contextCare(state: ProjectState, s: SessionFile): boolean {
    const applied = this.store.readApplied(s.id).entries;
    const asked = applied.find((a) => a.event === SUMMARY_ASKED);
    if (asked) {
      // Its summary turn runs; the fresh session's first turn waits while its runtime is beyond the usage threshold.
      const runtime = s.orchestrator_fallback?.target.runtime ?? runtimeOf(state.project);
      if (!this.idle() || this.runtimeFull(state, runtime)) return true;
      this.goOnFresh(s, asked);
      return true;
    }
    // Between turns only: not while a turn of the runtime's own may still start (AgentProcess.settling).
    if (this.proc?.state !== "idle" || this.proc.settling) return false;
    const live = this.store.readRuntime(s.id);
    const used = live?.context_tokens, window = live?.context_window;
    const limit = contextLimit(state.project.orchestrator?.context_threshold_tokens ?? DEFAULT_ORCHESTRATOR_CONTEXT_TOKENS, window);
    if (!used || !window || limit === undefined) return false;
    // FIRST_FILL holds the tokens a continuing session had at the end of its first turn (before queue CT: its share of
    // the window, a number up to 1).
    let first = applied.find((a) => a.event === FIRST_FILL);
    if (s.continues && !first) {
      first = { at: now(), event: FIRST_FILL, ok: true, message: String(used) };
      this.store.appendApplied(s.id, first);
    }
    const firstUsed = first ? (Number(first.message) <= 1 ? Number(first.message) * window : Number(first.message)) : undefined;
    if (used <= limit || (firstUsed !== undefined && firstUsed > limit) || this.runtimeFull(state)) return false;
    const fill = used / window;
    this.store.appendApplied(s.id, { at: now(), event: SUMMARY_ASKED, ok: true, message: String(fill), tokens: used });
    this.store.appendChat(s.id, { at: now(), from: "nexus", text: `The orchestrator's context is ${tokenText(used)} (${pct(fill)} % full; its threshold is ${tokenText(limit)}): Nexus asked it for a summary, and it goes on in a fresh session.` });
    this.deliver(orchestratorSummaryRequest(tokenText(used), tokenText(limit)));
    return true;
  }

  /**
   * The switch: a fresh orchestrator session that continues `old`, whose process ends. Its first message is the
   * summary `old` wrote after it was asked (also written to .nexus/orchestrator/summary.md), or a line that it left
   * none, what to do, the messages `old` had not read (answers, the user's words; notices are told again), and the
   * project's state as `nexus status` shows it. The current briefing comes with the new process.
   */
  private goOnFresh(old: SessionFile, asked: Applied): void {
    const fill = pct(Number(asked.message));
    const summary = this.summaryWritten(old, asked);
    const state = loadProjectState(this.store);
    const unread = (state.sessions.find((x) => x.id === old.id)?.inbox ?? []).filter((m) => !m.read_at && !m.id.startsWith("notice-"));
    const project = this.store.readProject();
    // On the runtime the settings name now: a runtime switch waiting for the summary is made here, with the summary.
    const target = old.orchestrator_fallback?.target ?? { runtime: runtimeOf(project), model: project.orchestrator?.model, effort: project.orchestrator?.effort };
    const fresh = this.newSession(project, { continues: old.id, ...target, model: target.model, effort: target.effort, orchestrator_fallback: old.orchestrator_fallback });
    this.store.writeSession(fresh);
    this.store.writeSession({ ...this.store.readSession(old.id), continued_by: fresh.id });
    if (summary) {
      const lists = summaryLists(summary);
      this.store.writeOrchestratorSummary(`# Orchestrator summary\n\nWritten by orchestrator session ${old.id} at ${summary.at}, when its context was ${fill} % full. The fresh session ${fresh.id} started from it.\n\n${summary.text.trim()}\n${lists.length ? `\n${lists.join("\n")}\n` : ""}`);
    }
    for (const m of unread) this.store.appendDelivered(old.id, { at: now(), kind: "inbox", id: m.id, via: "carried", to: fresh.id });
    const l = this.hosted;
    if (l) this.host.close(l.session);
    this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: fresh.id } }));
    this.store.appendChat(old.id, { at: now(), from: "nexus", text: `The orchestrator goes on in a fresh session (${fresh.id}).` });
    this.store.appendChat(fresh.id, { at: now(), from: "nexus", text: summary
      ? `A fresh orchestrator session: the previous one's context was ${fill} % full. It starts from the summary the previous session wrote (.nexus/orchestrator/summary.md), its current briefing and nexus status.`
      : `A fresh orchestrator session: the previous one's context was ${fill} % full. It left no summary, so the fresh session starts from its current briefing and nexus status only.` });
    this.ensure();
    const status = `project ${state.project.name} (${state.project.id})\n${orchestratorOverview(state)}`;
    this.deliver(orchestratorFreshSeed(fill, summary, status, carriedMessages(unread.map((m) => formatInbox(m, state)))));
  }

  /**
   * Answers to the orchestrator's own questions (nexus ask), routed to its current session (routeAnswers; also those
   * to a question of a session it went on from): each goes in once, as a turn or into the running one.
   */
  private deliverAnswers(state: ProjectState, s: SessionFile): void {
    const answers = (state.sessions.find((x) => x.id === s.id)?.inbox ?? []).filter((m) => m.type === "answer" && !m.read_at);
    if (!answers.length || this.runtimeFull(state)) return;
    this.ensure();
    for (const m of answers) {
      if (m.type !== "answer") continue;
      const q = state.questions.find((x) => x.qid === m.qid);
      this.store.appendDelivered(s.id, { at: now(), kind: "inbox", id: m.id, via: "turn" });
      this.store.appendChat(s.id, { at: now(), from: "nexus", text: `The ${m.from} answered the orchestrator's question${q ? ` "${q.text}"` : ""}:\n${m.text}` });
      this.deliver(formatInbox(m, state));
    }
  }

  // ---------------------------------------------------------------- requests from the orchestrator

  private applyRequests(s: SessionFile): void {
    if (this.applying) return;
    this.applying = true;
    try {
      const done = new Set(this.store.readApplied(s.id).entries.map((a) => a.event));
      const pending = this.store.readEvents(s.id).entries.filter((e) => REQUESTS.has(e.type) && !done.has(e.id));
      for (const e of pending) {
        let ok = true; let message: string;
        try { message = this.apply(e); }
        catch (err) { ok = false; message = (err as Error).message; }
        this.store.appendApplied(s.id, { at: now(), event: e.id, ok, message });
      }
    } finally { this.applying = false; }
  }

  private apply(e: Event): string {
    if (e.type === "queue.drafted") return applyDraft(this.store, e.definition);
    if (e.type === "review.sent_back") return sendBack(this.store, { queue: e.queue, step: e.step, from: "orchestrator", text: e.text, event: e.id });
    if (e.type === "plan.proposed") return proposePlan(this.store, e.queue, e.after, e.reason);
    if (e.type === "tags.proposed") return proposeTags(this.store, { area: e.area, activity: e.activity, rename: e.rename, reason: e.reason }, e.session);
    if (e.type === "metric.defined") return defineMetric(this.store, { name: e.name, unit: e.unit, show: e.show, target: e.target, warn_above: e.warn_above, warn_below: e.warn_below }, e.session);
    if (e.type === "recurring.set") {
      return this.engine.setRecurring({ id: e.recurring, template: e.template, params: e.params, every: e.every, after_queues: e.after_queues, maintenance: e.maintenance, by: "orchestrator", reason: e.reason });
    }
    if (e.type === "static_analysis.declined") return this.engine.declineStaticAnalysis(e.reason, e.session);
    if (e.type === "status.set") {
      const message = orchestratorStatusChange(this.store, { queue: e.queue, step: e.step, to: e.to, reason: e.reason });
      // A cancel reaches the user as a push notification, like other notifications; nothing waits in their list.
      if (e.to.trim().toLowerCase() === "cancelled") {
        const p = this.store.readProject();
        this.news.push?.({ title: `${p.name}: queue cancelled`, body: `${e.queue} cancelled by the orchestrator: ${e.reason}`.slice(0, 180), url: `/#/${encodeURIComponent(p.id)}/${encodeURIComponent(e.queue)}`, tag: `${p.id}:cancelled:${e.queue}`, kind: "cancelled" });
      }
      return message;
    }
    if (e.type !== "session.request") return "ignored";
    switch (e.action) {
      case "start": {
        const after = e.after === undefined ? [] : [e.after].flat();
        const planned = after.length > 0 || !!e.next;
        if (planned && e.start_at) throw new ActionError("give --after (or --next) or --at, not both");
        this.awayRule(e.queue, planned || !!e.start_at);
        if (e.start_at) return this.engine.scheduleStart(e.queue, { at: e.start_at, session: e.use_session, model: e.model, effort: e.effort, runtime: e.runtime, by: "orchestrator", reason: e.reason });
        if (planned) return this.engine.plan(e.queue, { after, session: e.use_session, model: e.model, effort: e.effort, runtime: e.runtime, by: "orchestrator", reason: e.reason });
        const run = this.engine.start(e.queue, { session: e.use_session, model: e.model, effort: e.effort, runtime: e.runtime });
        return `queue ${e.queue} started in session ${run.session}`;
      }
      case "cancel_start": return this.engine.cancelStart(e.queue, "orchestrator");
      case "pause": this.engine.pause(e.queue); return `queue ${e.queue} pauses after its current step`;
      case "resume": this.engine.resume(e.queue); return `queue ${e.queue} resumed`;
      case "stop": this.engine.stopNow(e.queue, e.reason); return `queue ${e.queue} stopped`;
    }
  }

  /**
   * While the user is away, only the plan's next queues start: the orchestrator starts no queue outside the plan, and
   * puts none into it that would start without the user (an approved queue not in the plan yet). A direct start is
   * left for a queue the plan would start now itself (in the plan, its predecessors done, approved).
   */
  private awayRule(queue: string, planning: boolean): void {
    const state = loadProjectState(this.store);
    if (!state.away.on) return;
    const q = state.queues.find((x) => x.id === queue);
    if (!q) return; // the engine refuses an unknown queue
    if (planning) {
      if (inPlan(q) || !q.approved) return;
      throw new ActionError(`the user is away: only the queues in the plan start meanwhile; queue ${queue} is approved but not in the plan, so planning it now would start it without the user. Leave it for the user's return, and say so in the chat`, 409);
    }
    const next = inPlan(q) && (!q.plan || q.plan.used || q.plan.ready) && !q.start?.at && q.approved;
    if (!next) throw new ActionError(`the user is away: only the plan's next queue starts meanwhile, and Nexus starts it by itself; queue ${queue} is ${inPlan(q) ? `not next in the plan (${q.start?.waiting || q.plan?.waiting || "it waits"})` : "not in the plan"}`, 409);
  }

  // ---------------------------------------------------------------- what the orchestrator is told

  /**
   * The orchestrator's active runtime is beyond the project's usage threshold now (routing.ts, overThreshold).
   * While it is, a timer looks again just after the reset, so the held notices go out without waiting for a change.
   */
  private runtimeFull(state: ProjectState, runtime: OrchestratorRuntime = this.session()?.runtime === "codex" ? "codex" : "claude"): boolean {
    const full = overThreshold(runtime, readUsage()?.windows ?? {}, state.project.defaults.usage_pause_threshold, this.nowMs());
    if (full && !this.heldTimer) this.wakeAt([full.until]);
    return !!full;
  }

  private notify(state: ProjectState, s: SessionFile, updateOnly = false): void {
    // A fresh session that goes on from earlier ones (context care) is told what none of them was told, since the first.
    const line = this.lineage(s);
    const told = new Set(line.flatMap((x) => this.store.readApplied(x.id).entries.map((a) => a.event)));
    const since = line.at(-1)!.created_at;
    // fact: what happened, shown in the chat too (unless `quiet`); todo: the instruction, for the orchestrator only;
    // more: further text for the orchestrator only, recorded under its own keys.
    const items: { key: string; fact: string; todo: string; quiet?: boolean; more?: { text: string; keys: string[] } }[] = [];
    const update = this.news.update();
    const mine = update && update.by.project === state.project.id && line.some((x) => x.id === update.by.session) && !told.has(update.key) ? update : undefined;
    // Changes for agents: with notices on, told now (and they start its turn); with them off, held for its next turn.
    // The orchestrator that ran the update gets them in the same message as its outcome. The user sees none of them.
    const changes = this.pendingChanges(s);
    const more = changes.length ? { text: describeDeployChanges(changes), keys: changes.map((d) => d.key) } : undefined;
    if (mine) items.push({ key: mine.key, fact: mine.fact, todo: mine.todo, more });
    else if (more && !updateOnly) items.push({ key: more.keys.join(" "), fact: more.text, todo: "", quiet: true, more: { text: "", keys: more.keys } });
    // A planned deploy that waits for the user's confirmation, or ended without its deploy (src/deploy-plan.ts): told
    // to the session that planned it (also with notices off: it answers its own command), else to this project's
    // orchestrator.
    for (const plan of this.news.plan()) {
      if (plan.project === state.project.id && plan.at >= since && (plan.session ? line.some((x) => x.id === plan.session) : !updateOnly)) {
        items.push({ key: plan.key, fact: plan.fact, todo: plan.todo });
      }
    }
    // The user's away mode: told when it comes on (or its end moves) and when it ends.
    if (!updateOnly) {
      const away = readAway();
      if (state.away.on && state.away.until! >= since) items.push({ key: `notify:away:on:${state.away.since}:${state.away.until}`, ...awayOnNotice({ until: state.away.until! }) });
      const last = away.past.at(-1);
      if (!state.away.on && last && last.ended >= since) items.push({ key: `notify:away:end:${last.since}`, ...awayEndNotice(last) });
    }
    // The user's decisions on its proposals for the project's tag lists: each told once.
    for (const d of updateOnly ? [] : state.tags.decisions) {
      if (d.at < since) continue;
      items.push({ key: `notify:tagdecision:${d.proposal.id}`, ...tagDecisionNotice(d) });
    }
    // A project without static analysis (src/static-reminder.ts): the server's latest monthly reminder, told once (also
    // to a session started after it), unless the user declined since.
    if (!updateOnly) {
      const note = this.store.readStaticAnalysisNote();
      if (note.reminded_at && !(note.declined && note.declined.at >= note.reminded_at)) {
        items.push({ key: `notify:static-analysis:${note.reminded_at}`, ...staticAnalysisNotice() });
      }
    }
    // The server's last crash (src/crash.ts): told once to a session that ran before it, whatever the dashboard shows.
    const crash = updateOnly ? undefined : this.news.crash();
    if (crash && crash.at >= since) items.push({ key: `notify:crash:${crash.at}`, ...serverCrashNotice(crash) });
    for (const x of updateOnly ? [] : state.questions) {
      const asker = state.sessions.find((y) => y.id === x.session);
      if (x.state !== "open" || asker?.role !== "worker" || x.asked_at < since) continue;
      items.push({ key: `notify:question:${x.qid}`, ...questionNotice(x) });
    }
    for (const q of updateOnly ? [] : state.queues) {
      const r = q.run;
      // Approvals and withdrawals by their position, so withdrawing and approving the same revision again is told again.
      q.approvals.forEach((a, i) => {
        if (a.at < since) return;
        items.push({ key: `notify:approval:${q.id}:${i}`, ...approvalNotice(q, a) });
      });
      // A lift by the user's Continue: told once, by its position in the queue's changes.
      q.changes.forEach((c, i) => {
        if (c.kind !== "lift" || c.by !== "user_continue" || c.at < since) return;
        items.push({ key: `notify:lift:${q.id}:${i}`, ...liftNotice(q, c) });
      });
      q.withdrawals.forEach((w, i) => {
        if (w.at < since) return;
        items.push({ key: `notify:withdrawal:${q.id}:${i}`, ...withdrawalNotice(q, w) });
      });
      // A step the user took over by setting its level to 1 while it waited for the orchestrator's review: told once.
      for (const st of q.steps) {
        if (st.status !== "review" || st.review_with !== "user" || st.asked_user?.by !== "user" || st.asked_user.at < since) continue;
        items.push({ key: `notify:leveltouser:${q.id}:${st.id}:${st.asked_user.at}`, ...levelToUserNotice(q, st) });
      }
      // A step waiting for its review: told whenever it entered review (also to a session started after that), once
      // per round.
      for (const st of q.steps) {
        // Not the integration step Nexus ran without a model and accepts itself (queue MI), nor one a review helper has.
        if (!this.forOrchestrator(state, q, st)) continue;
        items.push({ key: `notify:review:${q.id}:${st.id}:${st.finished_at}`, ...reviewNotice(q, st, state.away) });
      }
      // The checks Nexus ran (src/check-runs.ts): a failure accepted (and its fix queue), and a disputed failure that
      // waits for the orchestrator's decision. Each told once.
      for (const [step, entry] of Object.entries(q.check_runs?.steps ?? {})) {
        const st = q.steps.find((x) => x.id === step);
        if (!st) continue;
        for (const set of entry.sets) {
          // A check that is no command (queue EF): told once per queue and check, to convert it.
          for (const c of set.checks) {
            if (!c.not_command || (set.ended_at ?? set.requested_at) < since) continue;
            items.push({ key: `notify:checknotcommand:${q.id}:${c.name}`, ...checkNotCommandNotice(q, st, c.name) });
          }
          const d = set.dispute;
          if (!d || d.at < since) continue;
          if (set.state === "accepted") items.push({ key: `notify:checkaccepted:${q.id}:${step}:${set.done}`, ...checkAcceptedNotice(q, st, set) });
          else if (d.base?.state === "unrunnable" && !d.decided) items.push({ key: `notify:checkdecision:${q.id}:${step}:${set.done}`, ...checkDecisionNotice(q, st, set) });
        }
      }
      // A metric's value beyond its warning threshold: told once, if it came after the threshold was set.
      for (const st of q.steps) for (const m of st.metrics) {
        const def = m.warn && metricDef(state.metrics, m.name);
        if (!def || m.at < since || (def.at && m.at < def.at)) continue;
        items.push({ key: `notify:metric:${m.event}`, ...metricNotice(q, st, m) });
      }
      // While the user is away, a queue that waits for the user at a step (level 1, the send-back limit, or handed to
      // the user): which other approved queues can start now, once per such wait.
      if (state.away.on && q.status !== "done" && q.status !== "cancelled") {
        for (const st of q.steps) {
          if (st.status !== "review" || st.review_with !== "user") continue;
          const why = st.sent_back.some((b) => b.to_user) && st.asked_user ? "your send-backs reached the limit"
            : st.asked_user && st.asked_user.by !== "user" ? "you handed it to the user" : st.level === 1 ? "review level 1: the user reviews it" : "the user reviews it";
          const next = state.queues.filter((x) => x.id !== q.id && inPlan(x) && x.status !== "done" && x.status !== "cancelled" && !runGoing(x.run))
            .map((x) => ({ id: x.id, title: x.title, waiting: x.start?.waiting || x.plan?.waiting || "it may start" }));
          const paused = this.engine.startable(state).filter((x) => x.id !== q.id && x.status === "paused").map((x) => ({ id: x.id, title: x.title }));
          items.push({ key: `notify:awaywait:${q.id}:${st.id}:${st.asked_user?.at ?? st.finished_at}`, ...awayStuckNotice(q, st, why, next, paused) });
        }
      }
      // The plan: a planned queue whose predecessor is stopped, cancelled or gone waits (the user has it in their list);
      // the user's answers to proposals and the dependencies handed back. Each told once.
      const plan = openPlan(q);
      if (plan && q.status !== "done" && q.status !== "cancelled") {
        for (const e of plan.after) if (e.cause) items.push({ key: `notify:planheld:${q.id}:${e.queue}:${e.cause}`, ...planHeldNotice(q, e) });
      }
      q.plan?.decisions.forEach((d, i) => {
        if (d.at < since) return;
        items.push({ key: `notify:plandecision:${q.id}:${i}`, ...planDecisionNotice(q, d, q.plan!.decisions) });
      });
      // A scheduled start missed because the server was not running at its time: the user has it in their list.
      const missed = q.start?.failed?.missed ? q.start : undefined;
      if (missed && missed.failed!.at >= since) {
        items.push({ key: `notify:missed:${q.id}:${missed.at}`, ...missedStartNotice(q, missed) });
      }
      // Merging back (src/merger.ts): what keeps Nexus from it, once per reason; a merge back Nexus did by itself.
      const waiting = q.git?.merge?.waiting;
      if (waiting && waiting.since >= since) items.push({ key: `notify:mergewait:${q.id}:${waiting.since}`, ...mergeWaitNotice(q, waiting.reason, waiting.released) });
      // A done survey run's worktree that Nexus could not remove (untracked files left in it): told once.
      const cleanup = q.git?.cleanup?.waiting;
      if (cleanup && cleanup.since >= since && !q.git?.cleaned) items.push({ key: `notify:cleanupwait:${q.id}:${cleanup.since}`, ...cleanupWaitNotice(q, cleanup.reason) });
      // A step that opened on its fallback because its runtime's usage ran out, or on its own runtime again: told once.
      for (const f of r?.fallbacks ?? []) {
        if (f.at >= since) items.push({ key: `notify:fallback:${q.id}:${f.step}:${f.at}`, ...fallbackNotice(q, f) });
      }
      const merged = q.git?.merged;
      if (merged?.by === "nexus" && merged.at >= since) items.push({ key: `notify:merged:${q.id}:${merged.at}`, ...mergedNotice(q, merged) });
      if (!r) continue;
      // A pause someone asked for (the user, or you with nexus run pause), reached at a step's end. Not a stop, and
      // not the pauses of a server restart or an update, whose reasons differ.
      if (r.state === "paused" && r.reason?.startsWith("paused by the user") && r.ended_at && r.ended_at >= since) {
        items.push({ key: `notify:paused:${q.id}:${r.ended_at}`, ...pausedNotice(q, r) });
      }
      if ((r.state !== "halted" && r.state !== "finished") || r.updated_at < since) continue;
      // A maintenance run that finished: told once when its report has findings, else it closes quietly.
      if (q.maintenance && r.state === "finished") {
        if ((q.report?.findings ?? 0) > 0) items.push({ key: `notify:findings:${q.id}`, ...maintenanceFindingsNotice(q) });
        continue;
      }
      items.push({ key: `notify:run:${q.id}:${r.state}:${r.updated_at}`, ...runEndNotice(q, r) });
    }
    const fresh = items.filter((i) => !told.has(i.key));
    if (!fresh.length) return;
    // The orchestrator's own runtime beyond the usage threshold: nothing starts its turn. Each notice waits in its
    // inbox (once), not told yet; the reviews it would do (levels 2 and 3) wait with them. Told, all of them, at the
    // first change once that runtime is free again (docs/protocol/runtimes.md, "Fallback when usage runs out").
    const inbox = this.store.readInbox(s.id).entries;
    const held = (key: string) => `notice-${key}`;
    if (this.runtimeFull(state)) {
      for (const i of fresh) {
        if (inbox.some((m) => m.id === held(i.key))) continue;
        this.store.appendInbox(s.id, { v: 1, id: held(i.key), at: now(), from: "nexus", type: "message", text: noticeText(i, i.more?.text) });
      }
      return;
    }
    this.ensure();
    // What rides with a notice told anyway (queue RH): the steps accepted since by others, the review helper's
    // send-backs, its acceptances picked for an audit. With the last notice that has a fact; none starts a turn.
    const riding = updateOnly ? undefined : this.riders(state, told, since);
    const last = fresh.findLast((i) => !i.quiet);
    for (const i of fresh) {
      if (inbox.some((m) => m.id === held(i.key))) this.store.appendDelivered(s.id, { at: now(), kind: "inbox", id: held(i.key), via: "turn" });
      const rides = riding && i === last ? riding : undefined;
      if (i.quiet) this.markTold(s, i.more!.keys);
      else this.markTold(s, [i.key, ...(i.more?.keys ?? []), ...(rides?.keys ?? [])]);
      // The user sees the fact; the instruction after it, and any changes for agents, are for the orchestrator only.
      if (!i.quiet) this.store.appendChat(s.id, { at: now(), from: "nexus", text: i.fact });
      this.deliver(rides ? `${noticeText(i, i.more?.text)}\n\n${rides.text}` : noticeText(i, i.more?.text));
    }
  }

  /**
   * What the orchestrator learns of reviews it did not do (queue RH, H9-H11), not told yet in this session's line: the
   * steps accepted since by the review helper, Nexus or the user, and the helper's send-backs, oldest first; and the
   * helper's acceptances picked for an audit (`audited`). Undefined when there is nothing.
   */
  private riders(state: ProjectState, told: ReadonlySet<string>, since: string): { text: string; keys: string[] } | undefined {
    const role = (session: string) => state.sessions.find((x) => x.id === session)?.role;
    const lines: { at: string; key: string; text: string }[] = [];
    const audits: { key: string; text: string }[] = [];
    const rate = state.project.review_helper.audit_rate;
    for (const q of state.queues) for (const st of q.steps) {
      const a = st.accepted;
      if (a && a.by !== "orchestrator" && a.at >= since) {
        const key = `notify:accepted:${a.event}`;
        if (!told.has(key)) lines.push({ at: a.at, key, text: `step ${st.id} of queue ${q.id}: ${acceptedBy(a)}` });
        const audit = `notify:audit:${a.event}`;
        if (a.by === "helper" && !st.audit && !told.has(audit) && audited(a.event, rate)) {
          const packet = a.session ? normPath(join(this.store.sessionDir(a.session), "packet.md")) : "(none)";
          audits.push({ key: audit, text: `Audit: review again step ${st.id} of queue ${q.id}, which the review helper accepted (its packet: ${packet}; the step's work is in its queue's checkout). Judge it as you would review it, then answer: nexus review audit ${q.id} ${st.id} agree|disagree --reason "why". A disagreement does not reopen the step: if the work needs a fix, draft it as a revision.` });
        }
      }
      for (const e of st.timeline) {
        if (e.type !== "review.sent_back" || e.at < since || role(e.session) !== "helper") continue;
        const b = st.sent_back.find((x) => x.id === e.id);
        const key = `notify:helpersentback:${e.id}`;
        if (b && !told.has(key)) lines.push({ at: e.at, key, text: `step ${st.id} of queue ${q.id}: sent back by the review helper${b.to_user ? ", which handed it to the user (the send-back limit)" : `, round ${b.round}`}: ${e.text.split("\n")[0]}` });
      }
    }
    if (!lines.length && !audits.length) return undefined;
    lines.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
    const parts = [
      ...(lines.length ? [`Since your last notice (for your overview; nothing to do):\n${lines.map((l) => `- ${l.text}`).join("\n")}`] : []),
      ...audits.map((x) => x.text),
    ];
    return { text: parts.join("\n\n"), keys: [...lines.map((l) => l.key), ...audits.map((x) => x.key)] };
  }
}


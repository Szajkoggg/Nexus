// The project's orchestrator: one long-lived Claude Code session the user talks with in the dashboard. It plans
// queues and launches runs through `nexus` (queue.drafted, session.request), answers or escalates workers'
// questions, and is told when a worker asks or a run halts or finishes. It may read everything and write only queue
// drafts under .nexus/drafts/: permission mode dontAsk with a read-only allow list plus the drafts rules.
import { randomUUID } from "node:crypto";
import {
  ActionError, ClaudeEffort, ProjectStore, applyDraft, loadProjectState, orchestratorStatusChange, newId, now, sendBack, type ChatEntry, type Event, type ProjectState, type SessionFile,
} from "@nexus/protocol";
import type { AgentProcess } from "./agent.ts";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Launch } from "./agent-host.ts";
import type { Engine } from "./engine.ts";
import { orchestratorAgentsFile } from "./helpers.ts";
import { STOPPED, chatView } from "./chats.ts";
import type { UpdateNotice } from "./lifecycle.ts";
import { describeDeployChanges, type DeployChanges } from "./deploy.ts";
import {
  acceptedNoteNotice, approvalNotice, discardNotice, liftNotice, missedStartNotice, noticeText, orchestratorBriefing, pausedNotice,
  questionNotice, rejectionNotice, reviewNotice, runEndNotice, stepNoteNotice, userMessage, withdrawalNotice,
} from "./prompts.ts";

// Agent (formerly Task) lets it call subagents; they run within these same read-only permissions.
const READ_ONLY_TOOLS = [
  "Read", "Grep", "Glob", "Agent", "Task", "Bash(nexus:*)",
  "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git branch:*)", "Bash(git worktree list:*)",
];
// Queue drafts are files it writes and then hands to `nexus queue draft`: a long heredoc breaks in Claude Code's
// shell wrapper on Windows. Edit and Write stay out of NEVER because a disallow rule beats these path rules;
// dontAsk refuses writes anywhere else.
const DRAFTS = ".nexus/drafts";
const DRAFT_TOOLS = [`Write(${DRAFTS}/**)`, `Edit(${DRAFTS}/**)`];
const NEVER = ["NotebookEdit", "MultiEdit"];

/** A push notification for the user's devices (src/remote.ts `push`). */
export interface UserNotice { title: string; body: string; url: string; tag: string }

export class Orchestrator {
  private readonly host: AgentHost;
  private readonly store: ProjectStore;
  private readonly engine: Engine;
  private readonly changed: () => void;
  private applying = false;
  /**
   * News about Nexus itself: the outcome of an update, for the session that asked for it (src/lifecycle.ts), and the
   * changes for agents of each deploy, for every session older than it (src/deploy.ts).
   */
  private stopped = false;
  private readonly news: { update: () => UpdateNotice | undefined; changes: () => DeployChanges[]; push?: (n: UserNotice) => void };

  /** `host`: how its process is made (tests give a stand-in). */
  constructor(store: ProjectStore, engine: Engine, changed: () => void, news: { update?: () => UpdateNotice | undefined; changes?: () => DeployChanges[]; push?: (n: UserNotice) => void } = {}, host: AgentHostOptions = {}) {
    this.store = store;
    this.engine = engine;
    this.changed = changed;
    this.news = { update: news.update ?? (() => undefined), changes: news.changes ?? (() => []), push: news.push };
    this.host = new AgentHost(store, ROLE_RECORDS.orchestrator, host);
  }

  /** The orchestrator's process (one at a time): the latest one started, until it exits or Nexus ends it. */
  private get proc(): AgentProcess | undefined { return this.host.all()[0]?.proc; }

  /** The current orchestrator session, if one was ever started. */
  session(): SessionFile | undefined {
    const id = this.store.readProject().orchestrator?.session;
    if (!id) return undefined;
    try { return this.store.readSession(id); } catch { return undefined; }
  }

  view() {
    const s = this.session();
    const o = this.store.readProject().orchestrator;
    return {
      session: s ?? null,
      model: s?.model ?? o?.model ?? null,
      effort: s?.effort ?? o?.effort ?? null,
      state: this.proc?.state ?? "exited",
      runtime: s ? this.store.readRuntime(s.id) ?? null : null,
      // The newest 300 entries with their lines, and the session's pins (chats.ts); a fresh session has none.
      ...(s ? chatView(this.store, s.id, 300) : { chat: [], pins: [] }),
    };
  }

  /** A message from the user in the chat. */
  say(text: unknown): void {
    if (typeof text !== "string" || !text.trim()) throw new ActionError("the message is empty");
    const s = this.ensure();
    this.store.appendChat(s.id, { at: now(), from: "user", text: text.trim() });
    // Changes for agents held while notices are off go in with this turn (and count as told only now).
    const held = this.pendingChanges(s);
    if (held.length) this.markTold(s, held.map((d) => d.key));
    this.deliver(userMessage(text.trim(), held.length ? describeDeployChanges(held) : undefined));
  }

  /** Deploys whose changes for agents this session has not been told; none from before it started. */
  private pendingChanges(s: SessionFile): DeployChanges[] {
    const told = new Set(this.store.readApplied(s.id).entries.map((a) => a.event));
    return this.news.changes().filter((d) => d.at >= s.created_at && d.changes.length && !told.has(d.key));
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
    const e = effort === undefined || effort === null || effort === "" ? undefined : ClaudeEffort.safeParse(effort);
    if (e && !e.success) throw new ActionError(`effort is one of ${ClaudeEffort.options.join(", ")}`);
    this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, session: null, ...p.orchestrator, model: m, effort: e?.data } }));
    const s = this.session();
    if (s) this.store.writeSession({ ...s, model: m, effort: e?.data });
    // New settings wait for a running turn to end; the next message starts a process with them.
    const l = this.host.all()[0];
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
    const l = this.host.all()[0];
    if (l) this.host.close(l.session);
    this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: null } }));
  }

  /** After every change: carry out the orchestrator's requests and tell it what it should know. */
  onChange(state: ProjectState): void {
    if (this.stopped) return;
    let s = this.session();
    const notes = this.pendingNotes(state);
    if (!s) {
      // A step waiting for its review, or a note or rejection of the user's, starts it (after a reset, or before it ever ran).
      if (this.engine.draining || (!notes.length && !state.queues.some((q) => q.steps.some((x) => x.review_with === "orchestrator")))) return;
      s = this.ensure();
    }
    this.applyRequests(s);
    if (this.engine.draining) return; // held until the update settles: told after its restart, or once it fails
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
  }

  /**
   * Notes of the user's on an acceptance, for the orchestrator, that no orchestrator session has been told yet (each
   * is told once per project: a reset does not repeat it, and one made with no session starts one).
   */
  private pendingNotes(state: ProjectState): { key: string; queue: string; step: string; text: string; last: boolean; rejected?: boolean; discard?: string[]; note?: string }[] {
    const out: { key: string; queue: string; step: string; text: string; last: boolean; rejected?: boolean; discard?: string[]; note?: string }[] = [];
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
      if (e.type !== "review.accepted" || e.to !== "orchestrator" || !e.text) continue;
      out.push({ key: `notify:note:${e.id}`, queue: q.id, step: st.id, text: e.text, last: q.steps.at(-1)?.id === st.id });
    }
    if (!out.length) return out;
    const told = new Set(state.sessions.filter((x) => x.role === "orchestrator").flatMap((x) => this.store.readApplied(x.id).entries.map((a) => a.event)));
    return out.filter((n) => !told.has(n.key));
  }

  /** For good: an orchestrator shut down starts no process again (a late change, an agent's exit, may still come in). */
  shutdown(): void { this.stopped = true; this.host.shutdown(); }

  /** Its process is still running (after shutdown: not yet exited). */
  alive(): boolean { return !!this.proc && this.proc.state !== "exited"; }

  /** Not in the middle of a turn. */
  idle(): boolean { return !this.proc || this.proc.state !== "working"; }

  // ---------------------------------------------------------------- the session

  private ensure(): SessionFile {
    let s = this.session();
    const project = this.store.readProject();
    if (!s) {
      s = {
        protocol: 1, id: newId(), project: project.id, role: "orchestrator", runtime: "claude", native_id: randomUUID(),
        title: "Orchestrator", cwd: project.root, launched_by: "nexus", created_at: now(),
        model: project.orchestrator?.model, effort: project.orchestrator?.effort,
      };
      this.store.writeSession(s);
      const id = s.id;
      this.store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: id } }));
    }
    // Settings it was started with changed since (its model or effort, global or the project's own; a threshold its
    // briefing names): a new process from this message on (a working one ends after its turn, and this message goes
    // into that turn), resuming the conversation.
    if (this.proc && this.proc.state !== "exited" && this.host.stale(s.id, this.launcher(s))) {
      if (this.proc.state === "working") this.host.restartAfterTurn(s.id); else this.host.retire(s.id);
    }
    if (!this.proc || this.proc.state === "exited") this.spawn(s);
    return s;
  }

  /** How its process is started, from the project's effective settings now (the orchestrator's model and effort). */
  private launcher(s: SessionFile): (resume: boolean) => Launch {
    const project = this.store.readProject();
    const o = project.orchestrator;
    return (resume) => ({ runtime: "claude", options: {
      cwd: s.cwd, uuid: s.native_id!, resume, model: o ? o.model : s.model, effort: o ? o.effort : s.effort,
      permissionMode: "dontAsk",
      allowedTools: [...READ_ONLY_TOOLS, ...DRAFT_TOOLS],
      disallowedTools: NEVER,
      appendSystemPrompt: orchestratorBriefing(project.name, Math.round(project.defaults.context_reuse_threshold * 100), project.languages),
      agentsFile: orchestratorAgentsFile(),
      env: this.host.env(s.id),
    } });
  }

  private spawn(s: SessionFile): void {
    // Its session records the model and effort it runs on (the project's effective ones).
    const o = this.store.readProject().orchestrator;
    if (o && (o.model !== s.model || o.effort !== s.effort)) this.store.writeSession({ ...s, model: o.model, effort: o.effort });
    this.host.start(s, this.launcher(s), {}, () => ({
      // The chat gets the orchestrator's texts whole; the activity log keeps them clipped.
      message: (text) => this.store.appendChat(s.id, { at: now(), from: "orchestrator", text }),
      activity: (a) => {
        if (a.kind === "tool") this.store.appendChat(s.id, { at: now(), from: "orchestrator", kind: "tool", text: a.text });
        else if (a.kind === "error" || (a.kind === "turn_end" && a.text.includes("error"))) this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: a.text });
        this.store.appendActivity(s.id, { at: now(), ...a });
      },
      turnEnd: () => this.changed(),
      exit: () => this.changed(),
    }));
  }

  private deliver(text: string): void {
    const proc = this.proc!;
    proc.send(text, proc.state === "working" ? "next" : undefined);
    this.changed();
  }

  // ---------------------------------------------------------------- requests from the orchestrator

  private applyRequests(s: SessionFile): void {
    if (this.applying) return;
    this.applying = true;
    try {
      const done = new Set(this.store.readApplied(s.id).entries.map((a) => a.event));
      const pending = this.store.readEvents(s.id).entries.filter((e) => (e.type === "queue.drafted" || e.type === "session.request" || e.type === "status.set" || e.type === "review.sent_back") && !done.has(e.id));
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
    if (e.type === "status.set") {
      const message = orchestratorStatusChange(this.store, { queue: e.queue, step: e.step, to: e.to, reason: e.reason });
      // A cancel reaches the user as a push notification, like other notifications; nothing waits in their list.
      if (e.to.trim().toLowerCase() === "cancelled") {
        const p = this.store.readProject();
        this.news.push?.({ title: `${p.name}: queue cancelled`, body: `${e.queue} cancelled by the orchestrator: ${e.reason}`.slice(0, 180), url: `/#/${encodeURIComponent(p.id)}/${encodeURIComponent(e.queue)}`, tag: `${p.id}:cancelled:${e.queue}` });
      }
      return message;
    }
    if (e.type !== "session.request") return "ignored";
    switch (e.action) {
      case "start": {
        if (e.after && e.start_at) throw new ActionError("give --after or --at, not both");
        if (e.start_at) return this.engine.scheduleStart(e.queue, { at: e.start_at, session: e.use_session, model: e.model, effort: e.effort, runtime: e.runtime, by: "orchestrator", reason: e.reason });
        if (e.after) return this.engine.chain(e.queue, { after: e.after, session: e.use_session, model: e.model, effort: e.effort, runtime: e.runtime, by: "orchestrator", reason: e.reason });
        const run = this.engine.start(e.queue, { session: e.use_session, model: e.model, effort: e.effort, runtime: e.runtime });
        return `queue ${e.queue} started in session ${run.session}`;
      }
      case "cancel_start": return this.engine.cancelStart(e.queue);
      case "pause": this.engine.pause(e.queue); return `queue ${e.queue} pauses after its current step`;
      case "resume": this.engine.resume(e.queue); return `queue ${e.queue} resumed`;
      case "stop": this.engine.stopNow(e.queue, e.reason); return `queue ${e.queue} stopped`;
    }
  }

  // ---------------------------------------------------------------- what the orchestrator is told

  private notify(state: ProjectState, s: SessionFile, updateOnly = false): void {
    const told = new Set(this.store.readApplied(s.id).entries.map((a) => a.event));
    const since = s.created_at;
    // fact: what happened, shown in the chat too (unless `quiet`); todo: the instruction, for the orchestrator only;
    // more: further text for the orchestrator only, recorded under its own keys.
    const items: { key: string; fact: string; todo: string; quiet?: boolean; more?: { text: string; keys: string[] } }[] = [];
    const update = this.news.update();
    const mine = update && update.by.project === state.project.id && update.by.session === s.id && !told.has(update.key) ? update : undefined;
    // Changes for agents: with notices on, told now (and they start its turn); with them off, held for its next turn.
    // The orchestrator that ran the update gets them in the same message as its outcome. The user sees none of them.
    const changes = this.pendingChanges(s);
    const more = changes.length ? { text: describeDeployChanges(changes), keys: changes.map((d) => d.key) } : undefined;
    if (mine) items.push({ key: mine.key, fact: mine.fact, todo: mine.todo, more });
    else if (more && !updateOnly) items.push({ key: more.keys.join(" "), fact: more.text, todo: "", quiet: true, more: { text: "", keys: more.keys } });
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
      // A step waiting for its review: told whenever it entered review (also to a session started after that), once
      // per round.
      for (const st of q.steps) {
        if (st.status !== "review" || st.review_with !== "orchestrator") continue;
        items.push({ key: `notify:review:${q.id}:${st.id}:${st.finished_at}`, ...reviewNotice(q, st) });
      }
      // A scheduled start missed because the server was not running at its time: the user has it in their list.
      const missed = q.start?.failed?.missed ? q.start : undefined;
      if (missed && missed.failed!.at >= since) {
        items.push({ key: `notify:missed:${q.id}:${missed.at}`, ...missedStartNotice(q, missed) });
      }
      if (!r) continue;
      // A pause someone asked for (the user, or you with nexus run pause), reached at a step's end. Not a stop, and
      // not the pauses of a server restart or an update, whose reasons differ.
      if (r.state === "paused" && r.reason?.startsWith("paused by the user") && r.ended_at && r.ended_at >= since) {
        items.push({ key: `notify:paused:${q.id}:${r.ended_at}`, ...pausedNotice(q, r) });
      }
      if ((r.state !== "halted" && r.state !== "finished") || r.updated_at < since) continue;
      items.push({ key: `notify:run:${q.id}:${r.state}:${r.updated_at}`, ...runEndNotice(q, r) });
    }
    const fresh = items.filter((i) => !told.has(i.key));
    if (!fresh.length) return;
    this.ensure();
    for (const i of fresh) {
      if (i.quiet) this.markTold(s, i.more!.keys);
      else this.markTold(s, [i.key, ...(i.more?.keys ?? [])]);
      // The user sees the fact; the instruction after it, and any changes for agents, are for the orchestrator only.
      if (!i.quiet) this.store.appendChat(s.id, { at: now(), from: "nexus", text: i.fact });
      this.deliver(noticeText(i, i.more?.text));
    }
  }
}

export type { ChatEntry };

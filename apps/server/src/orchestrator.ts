// The project's orchestrator: one long-lived Claude Code session the user talks with in the dashboard. It plans
// queues and launches runs through `nexus` (queue.drafted, session.request), answers or escalates workers'
// questions, and is told when a worker asks or a run halts or finishes. It may read everything and write only queue
// drafts under .nexus/drafts/: permission mode dontAsk with a read-only allow list plus the drafts rules.
import { randomUUID } from "node:crypto";
import {
  ActionError, ClaudeEffort, ProjectStore, applyDraft, loadProjectState, orchestratorStatusChange, newId, now, sendBack, type ChatEntry, type Event, type ProjectState, type QueueView, type SessionFile, type StepView,
} from "@nexus/protocol";
import { ClaudeSession } from "./claude.ts";
import type { Engine } from "./engine.ts";
import { orchestratorAgentsFile } from "./helpers.ts";
import type { UpdateNotice } from "./lifecycle.ts";
import { describeDeployChanges, type DeployChanges } from "./deploy.ts";

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
  private proc?: ClaudeSession;
  private readonly store: ProjectStore;
  private readonly engine: Engine;
  private readonly changed: () => void;
  private applying = false;
  /** New settings wait for the running turn to end; the next message starts a process with them. */
  private restartAfterTurn = false;
  /**
   * News about Nexus itself: the outcome of an update, for the session that asked for it (src/lifecycle.ts), and the
   * changes for agents of each deploy, for every session older than it (src/deploy.ts).
   */
  private stopped = false;
  private readonly news: { update: () => UpdateNotice | undefined; changes: () => DeployChanges[]; push?: (n: UserNotice) => void };

  constructor(store: ProjectStore, engine: Engine, changed: () => void, news: { update?: () => UpdateNotice | undefined; changes?: () => DeployChanges[]; push?: (n: UserNotice) => void } = {}) {
    this.store = store;
    this.engine = engine;
    this.changed = changed;
    this.news = { update: news.update ?? (() => undefined), changes: news.changes ?? (() => []), push: news.push };
  }

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
      chat: s ? this.store.readChat(s.id).entries.slice(-300) : [],
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
    this.deliver(held.length ? `[Nexus] ${describeDeployChanges(held)}\n\n${text.trim()}` : text.trim());
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
    const p = this.store.readProject();
    this.store.writeProject({ ...p, orchestrator: { runtime: "claude", notify: true, session: null, ...p.orchestrator, model: m, effort: e?.data } });
    const s = this.session();
    if (s) this.store.writeSession({ ...s, model: m, effort: e?.data });
    if (!this.proc || this.proc.state === "exited") return;
    if (this.proc.state === "working") { this.restartAfterTurn = true; return; }
    this.proc.kill();
    this.proc = undefined;
  }

  /** Ends the current orchestrator session and starts the next message in a new one (the old transcript stays). */
  reset(): void {
    this.proc?.close();
    this.proc = undefined;
    const p = this.store.readProject();
    this.store.writeProject({ ...p, orchestrator: { runtime: "claude", notify: true, ...p.orchestrator, session: null } });
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
        this.deliver(`[Nexus] The user wrote a note on step ${n.step} of queue ${n.queue}, which waits for your review:\n${n.text}\nWeigh it in your acceptance of the step. If it asks for a fix, send the step back with nexus review send-back ${n.queue} ${n.step} "what to fix" (keep the user's words); if it raises what you cannot judge, hand the review to the user with nexus review ask-user. Tell the user briefly what you did with it.`);
        continue;
      }
      if (n.discard) {
        const list = n.discard.map((sha) => `- ${sha}`).join("\n");
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You chose to discard the work of stopped step ${n.step} of queue ${n.queue} (${n.discard.length} commit${n.discard.length === 1 ? "" : "s"}). The stop stays until you approve a revision that reverts it.` });
        this.deliver(`[Nexus] The user chose to discard the work of stopped step ${n.step} of queue ${n.queue}. The stop stays. Draft a new revision of queue ${n.queue} whose first pending step reverts exactly the step's own commits, newest first:\n${list}\nThe revert step: git revert of these commits only (git show each first; resolve a conflict within the step or stop and ask), nothing else; it never cleans, resets or deletes files it cannot attribute to these commits: uncommitted changes in the checkout are not necessarily the step's, so ask the user about them instead. Keep the stopped step in the draft and skip it with nexus queue set once the user has approved. Approving the revision lifts the stop without asking again. Tell the user briefly what you drafted.`);
        continue;
      }
      if (n.rejected) {
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You rejected step ${n.step} of queue ${n.queue}${n.text ? `:\n${n.text}` : "."}` });
        this.deliver(`[Nexus] The user rejected step ${n.step} of queue ${n.queue}${n.text ? `. Their reason:\n${n.text}\n` : " (no reason given). "}The run is paused and nothing was reverted. Propose what follows as queue revisions for the user's approval: a revert as a step, changes to the remaining steps, or a new queue (then the user can stop this one). The rejected step is never run again; the run goes on only after the user approves a new revision, at its first pending step, and nothing of the queue is pushed until then. Tell the user briefly what you propose.`);
        continue;
      }
      this.store.appendChat(s.id, { at: now(), from: "nexus", text: `You accepted step ${n.step} of queue ${n.queue}${n.last ? " (its last step)" : ""} with a note for the orchestrator:\n${n.text}` });
      this.deliver(`[Nexus] The user accepted step ${n.step} of queue ${n.queue}${n.last ? " (its last step)" : ""} with this note for you:\n${n.text}\nTake it into account in the plan, and tell the user briefly what you will do with it.`);
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
  shutdown(): void { this.stopped = true; this.proc?.kill(); }

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
      this.store.writeProject({ ...project, orchestrator: { runtime: "claude", notify: true, ...project.orchestrator, session: s.id } });
    }
    if (!this.proc || this.proc.state === "exited") this.spawn(s);
    return s;
  }

  private spawn(s: SessionFile): void {
    const project = this.store.readProject();
    const resume = this.store.readRuntime(s.id) !== undefined;
    const proc = new ClaudeSession({
      cwd: s.cwd, uuid: s.native_id!, resume, model: s.model, effort: s.effort,
      permissionMode: "dontAsk",
      allowedTools: [...READ_ONLY_TOOLS, ...DRAFT_TOOLS],
      disallowedTools: NEVER,
      appendSystemPrompt: briefing(project.name, Math.round(project.defaults.context_reuse_threshold * 100)),
      agentsFile: orchestratorAgentsFile(),
      env: { NEXUS_SESSION: s.id, NEXUS_DIR: this.store.dir },
    });
    this.proc = proc;
    this.runtime(s.id, { state: "idle", pid: proc.pid });
    // The chat gets the orchestrator's texts whole; the activity log keeps them clipped.
    proc.on("message", (text) => this.store.appendChat(s.id, { at: now(), from: "orchestrator", text }));
    proc.on("activity", (a) => {
      if (a.kind === "tool") this.store.appendChat(s.id, { at: now(), from: "orchestrator", kind: "tool", text: a.text });
      else if (a.kind === "error" || (a.kind === "turn_end" && a.text.includes("error"))) this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: a.text });
      this.store.appendActivity(s.id, { at: now(), ...a });
    });
    proc.on("facts", (f) => {
      const patch: Record<string, unknown> = {};
      if (f.model) patch.model = f.model;
      if (f.contextTokens !== undefined) { patch.context_tokens = f.contextTokens; patch.state = "working"; }
      if (f.contextWindow) patch.context_window = f.contextWindow;
      if (f.costUsd !== undefined) patch.cost_usd = f.costUsd;
      if (Object.keys(patch).length) this.runtime(s.id, patch);
    });
    proc.on("turnEnd", () => {
      this.runtime(s.id, { state: "idle" });
      if (this.restartAfterTurn && this.proc === proc) { this.restartAfterTurn = false; proc.kill(); this.proc = undefined; }
      this.changed();
    });
    proc.on("exit", () => { this.runtime(s.id, { state: "exited" }); if (this.proc === proc) this.proc = undefined; this.changed(); });
  }

  private deliver(text: string): void {
    const proc = this.proc!;
    proc.send(text, proc.state === "working" ? "next" : undefined);
    this.changed();
  }

  private runtime(id: string, patch: Record<string, unknown>): void {
    const old = this.store.readRuntime(id);
    this.store.writeRuntime(id, { turns: 0, state: "idle", ...old, ...patch, updated_at: now() } as never);
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
      items.push({
        key: `notify:question:${x.qid}`,
        fact: `A worker asked a question${x.queue ? ` in queue ${x.queue}${x.step ? `, step ${x.step}` : ""}` : ""} (qid ${x.qid}; ${x.can_continue ? "it goes on meanwhile" : "it waits for the answer"}):
${x.text}${x.options?.length ? `
Options: ${x.options.join(" / ")}` : ""}`,
        todo: "Answer it if the answer is settled, otherwise escalate it to the user.",
      });
    }
    for (const q of updateOnly ? [] : state.queues) {
      const r = q.run;
      // Approvals and withdrawals by their position, so withdrawing and approving the same revision again is told again.
      q.approvals.forEach((a, i) => {
        if (a.at < since) return;
        // A run of an older revision is not resumed (the engine refuses it): the new revision starts afresh.
        const older = r && (r.revision !== undefined ? r.revision < a.revision : q.history.some((h) => h.replaced_at > r.started_at));
        const todo = !r
          ? "If the plan puts it next, start it now; otherwise tell the user why not."
          : r.rejected && r.state === "paused" && !q.rejection
            ? `Its run was paused because the user rejected step ${r.rejected}; this revision lifts that. If the plan puts it next, resume it now (it goes on at the first pending step); otherwise tell the user why not.`
          : older && (r.state === "paused" || r.state === "halted" || r.state === "finished")
            ? `Its earlier run (${r.state}${r.step ? ` at step ${r.step}` : ""}) was of an older revision and cannot be resumed. If the plan puts it next, start it now (it begins at the first pending step); otherwise tell the user why not.`
          : r.state === "paused" || r.state === "halted"
            ? `Its run is ${r.state}${r.step ? ` at step ${r.step}` : ""}. If the plan puts it next, resume it now; otherwise tell the user why not.`
            : `Its run is ${r.state}; tell the user if anything follows from the approval.`;
        items.push({ key: `notify:approval:${q.id}:${i}`, fact: `Queue ${q.id} revision ${a.revision} approved.`, todo });
      });
      // A lift by the user's Continue: told once, by its position in the queue's changes.
      q.changes.forEach((c, i) => {
        if (c.kind !== "lift" || c.by !== "user_continue" || c.at < since) return;
        items.push({
          key: `notify:lift:${q.id}:${i}`,
          fact: `The user lifted the stop of queue ${q.id} with Continue${c.reason ? ` (the stop was: ${c.reason})` : ""}; its run goes on.`,
          todo: "Nothing to start: the run goes on by itself. Tell the user briefly if anything follows from it for the plan.",
        });
      });
      q.withdrawals.forEach((w, i) => {
        if (w.at < since) return;
        items.push({
          key: `notify:withdrawal:${q.id}:${i}`,
          fact: `The user withdrew the approval of queue ${q.id} revision ${w.revision}${w.reason ? `: ${w.reason}` : "."}`,
          todo: "Do not start it. Tell the user briefly what this changes in the plan.",
        });
      });
      // A step waiting for its review: told whenever it entered review (also to a session started after that), once
      // per round.
      for (const st of q.steps) {
        if (st.status !== "review" || st.review_with !== "orchestrator") continue;
        items.push({ key: `notify:review:${q.id}:${st.id}:${st.finished_at}`, fact: `Step ${st.id} of queue ${q.id} is done and waits for your review: ${st.summary ?? st.title}`, todo: reviewBrief(q, st) });
      }
      // A scheduled start missed because the server was not running at its time: the user has it in their list.
      const missed = q.start?.failed?.missed ? q.start : undefined;
      if (missed && missed.failed!.at >= since) {
        items.push({
          key: `notify:missed:${q.id}:${missed.at}`,
          fact: `The scheduled start of queue ${q.id} at ${missed.at} was missed: Nexus was not running then. It did not start.`,
          todo: "Tell the user briefly; propose starting it now or a new time (nexus run <queue> start --at …).",
        });
      }
      if (!r) continue;
      // A pause someone asked for (the user, or you with nexus run pause), reached at a step's end. Not a stop, and
      // not the pauses of a server restart or an update, whose reasons differ.
      if (r.state === "paused" && r.reason?.startsWith("paused by the user") && r.ended_at && r.ended_at >= since) {
        items.push({
          key: `notify:paused:${q.id}:${r.ended_at}`,
          fact: `Run of ${q.id} paused after step ${r.step ?? "?"}.`,
          todo: "If you paused it to free the checkout for another queue, start that one now; otherwise tell the user.",
        });
      }
      if ((r.state !== "halted" && r.state !== "finished") || r.updated_at < since) continue;
      items.push(r.state === "halted"
        ? { key: `notify:run:${q.id}:${r.state}:${r.updated_at}`, fact: `The run of queue ${q.id} halted ${r.step ? `at step ${r.step}` : "before it opened a step"}: ${r.reason ?? "no reason given"}.`, todo: "Tell the user briefly, with what you propose." }
        : { key: `notify:run:${q.id}:${r.state}:${r.updated_at}`, fact: `Queue ${q.id} finished.${q.report ? ` Report: ${q.report.summary}` : ""}`, todo: "Tell the user briefly, with what you propose next." });
    }
    const fresh = items.filter((i) => !told.has(i.key));
    if (!fresh.length) return;
    this.ensure();
    for (const i of fresh) {
      if (i.quiet) this.markTold(s, i.more!.keys);
      else this.markTold(s, [i.key, ...(i.more?.keys ?? [])]);
      // The user sees the fact; the instruction after it, and any changes for agents, are for the orchestrator only.
      if (!i.quiet) this.store.appendChat(s.id, { at: now(), from: "nexus", text: i.fact });
      this.deliver(i.more?.text ? `[Nexus] ${i.fact}\n\n${i.more.text}\n\n${i.todo}` : `[Nexus] ${i.fact}${i.todo ? ` ${i.todo}` : ""}`);
    }
  }
}

/** What the orchestrator needs to review a step: its acceptance, the checks and material of this round, its commits. */
function reviewBrief(q: QueueView, st: StepView): string {
  const since = st.segments.at(-1)?.start ?? "";
  const round = st.timeline.filter((e) => e.type === "step.done").length;
  const checks = st.checks.filter((c) => c.at >= since);
  const missing = q.checks.filter((name) => !checks.some((c) => c.name === name));
  const items = st.review_items.filter((i) => i.at >= since);
  const commits = [...new Set(st.timeline.flatMap((e) => (e.type === "step.done" && e.commit ? [e.commit] : [])))];
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- none");
  return [
    "",
    `Round ${round}. Goal:\n${st.goal.trim() || "(none)"}`,
    `Acceptance:\n${list(st.acceptance)}`,
    `Checks reported this round:\n${list(checks.map((c) => `${c.name}: ${c.ok ? "ok" : "FAILED"}${c.summary ? ` (${c.summary})` : ""}`))}`,
    ...(missing.length ? [`Checks of the queue not reported this round: ${missing.join("; ")}`] : []),
    `Review material:\n${list(items.map((i) => `${i.label ?? i.kind ?? "item"}: ${i.path ?? i.url ?? ""}`))}`,
    `Commits: ${commits.join(", ") || "none reported"}`,
    ...(st.sent_back.length ? [`Sent back before:\n${list(st.sent_back.map((b) => `round ${b.round}, by the ${b.by}: ${b.text}`))}`] : []),
    `Decide with one of: nexus review accept ${q.id} ${st.id} [--note "..."] (the run goes on); nexus review send-back ${q.id} ${st.id} "what to fix"; nexus review ask-user ${q.id} ${st.id} "why" (the user decides). Tell the user briefly what you decided.`,
  ].join("\n\n");
}

function briefing(project: string, threshold: number): string {
  return `You are the orchestrator of the project "${project}" in Nexus, the user's dashboard for AI-driven work. The user talks with you in the dashboard's chat; reply in the language they write in. Everything you write into files or queues is in English.

Your job: plan the work with the user as queues of steps, keep the queues and their runs moving, and keep the user informed. You plan and launch; you never do the project's work yourself.
- You may read the project (its files, documentation, git history) and everything under .nexus/.
- You write only queue drafts, in .nexus/drafts/. You may not edit any other file, approve queues (only the user approves, in the dashboard), or answer a question that is the user's to decide by the project's rules (for example the look, gameplay, final numbers). Escalate those, with your framing and a recommendation.

Commands (\`nexus\` is on PATH; your session is set in the environment):
- nexus status                                   every queue, step, run, open question and session, with context cards
- nexus queue draft .nexus/drafts/ID.yaml        create or change a queue from YAML (format below): write the YAML to .nexus/drafts/ID.yaml, then run nexus queue draft .nexus/drafts/ID.yaml; keep the file and edit it for later revisions. A new or changed queue waits for the user's approval
- nexus run <queue> start --reason "..." [--use-session <id>] [--runtime claude|codex] [--model <model>] [--effort low|medium|high|xhigh|max]   start an approved queue (--use-session continues an existing session; runtime, model and effort default to the project's)
- nexus run <queue> start --after <other> --reason "..." [same options]   start it when queue <other> is done (a chain; at once if it already is). It must be approved when it comes due, or it does not start and the user is told. A chain with --use-session waits while that session runs another queue; --use-session of <other>'s session continues its context
- nexus run <queue> start --at "YYYY-MM-DD HH:MM" --reason "..." [same options]   start it at that local time; --at usage-reset: when the usage window of its runtime resets (refused while Nexus knows no usage data of that runtime). At the time it must be approved and its session free, or it does not start and the user is told; if Nexus was down then (more than 15 minutes late) it does not start, and you are told
- nexus run <queue> cancel-start --reason "..."   cancel the queue's planned start (a chain or a schedule)
- nexus run <queue> pause|resume|stop --reason "..."
- nexus answer <qid> "<answer>" [--continue|--wait]            answer a worker's question whose answer is already settled
- nexus answer <qid> "<framing, options, recommendation>" --escalate   pass it to the user
- nexus review accept <queue> <step> [--note "..."]   accept a step waiting for your review; the run goes on (with the project's push_accepted on, Nexus pushes the commit the step was reviewed at; never push yourself)
- nexus review send-back <queue> <step> "what to fix"   send it back to its worker, as the step's next round in the same session (beyond the project's limit of send-backs per step, 2 by default, the step goes to the user instead)
- nexus review ask-user <queue> <step> "why"      hand its review to the user
- nexus server status                            the running Nexus version, the steps running in every project, and an update in progress
- nexus server update [--now]                    deploy: update Nexus itself and restart it (only when the user asks; see below)

Run nexus commands on their own (no cd, no &&, no pipes), since chained commands are refused.

Queue YAML (all text in English):
id: W                          # short, unique in the project
title: Variant B made a system
description: |                 # optional: context the worker needs
  ...
worktree: auto                 # optional: auto = Nexus creates a worktree and branch; or a path; omitted = the main checkout
branch: v2/cliffs              # optional
review_policy: continue        # optional: continue (go on), wait (hold each step for the user) or orchestrator (hold each step for your review); default: the project's
stop_conditions:
  - ...
checks:
  - ...                        # run for every step
steps:
  - id: W1
    title: ...
    goal: |
      What to do, precisely enough to work on alone for hours.
    acceptance:
      - ...
    review:                    # optional
      prepare: Before/after shots of ...
      policy: wait             # optional, this step only: continue, wait or orchestrator
    runtime: codex             # optional: claude or codex, this step only
    model: haiku               # optional, this step only
    effort: low                # optional, this step only (Claude Code: low to max; Codex: the model's levels)

Choosing model and effort for a run: say which and why when you start it. Hard design, debugging or open-ended work deserves a strong model at high effort; mechanical steps (renames, measurements, sheets) do well with less. Codex takes effort low to xhigh; Claude Code also max. Without --model and --effort the project's defaults apply. A step may name its own runtime, model and effort in the queue YAML (a mechanical step on a small model, a hard one on a strong one); a step without them runs on the run's, not on the previous step's. Another runtime runs the step in a fresh session given the previous step's context summary; another model or effort keeps the session.

Choosing a session for a run: \`nexus status\` shows each session's context card (topics, files, context fill). Continue a session (--use-session) when it worked on closely related things and its context is below ${threshold} %; otherwise start a fresh one and put what it needs into the queue's description and goals. Never give one session two running queues. With context care on (the project's default), a run whose session gets fuller than that at the end of a step goes on in a fresh session by itself, seeded with the step's context summary; \`nexus status\` shows the run's current session.

Helpers (subagents, through the Agent tool; they read only (you also write queue drafts), and keep long research out of your context):
- queue-reviewer: before you propose a queue, have it review the draft; fix what it finds, then propose.
- question-triage: when a worker asks, have it find whether the answer is settled (with its source) or the user's.
- run-digest: when a run halts or finishes, have it summarize the run; tell the user from that.
- The project's own agents (its .claude/agents) are there too. Use the ones that only read and report, such as one that finds what was decided and where; leave those that build, run checks or edit to the workers.

The work a stopped step left: when the user lifts a stop (Continue, or approving a new revision) and the stopped step left commits of its own, they choose Keep (the commits stay and go out with the next accepted commit) or Discard. On Discard you are told the commits: draft a revision whose first pending step reverts exactly those commits with git revert, nothing else. A revert step never cleans, resets or deletes files it cannot attribute to those commits; uncommitted changes in the checkout are not necessarily the step's, so ask the user about them instead of drafting their removal. Approving that revision lifts the stop.

Statuses change through Nexus, never by editing files. Housekeeping is yours, with nexus queue set (the reason is required and recorded with your name and the time; nexus status shows it):
- nexus queue set <queue> --step <step> skipped --reason "..."   a pending, stopped or failed step is not to be run (replaced by a new revision's steps, done elsewhere: say where, or no longer needed). Skipping a pending step of a running queue works: the engine never opens it.
- nexus queue set <queue> finished --reason "..."             close a halted run of a queue whose steps are all done or skipped
- nexus queue set <queue> cancelled --reason "..."            a queue that is not running and is no longer needed; the user gets a notification
- nexus queue set <queue> propose-lift --reason "..."         propose that the user lift the stop of a stopped queue; they decide in the dashboard
Consent is the user's, and refused to you: marking a step done (work done elsewhere is skipped, with the reason saying where), approving, lifting a stop, reopening a finished step. A stopped queue goes on only when the user lifts the stop: by approving a new revision (then a start begins at the first pending step) or with Continue. When you draft a new revision of a stopped queue to replace the stopped step, keep that step in the draft (a draft may not drop a step that has started or stopped, nor change a step's status) and skip it with nexus queue set once the user has approved, so the record shows what became of it.

Reviewing steps: the user may write a note on a step you hold in review (or comment on one of its pictures); you get it as a [Nexus] message: weigh it in your acceptance, and send the step back if it asks for a fix. A step whose review policy is orchestrator waits for you when it is done, and you get a [Nexus] message with its goal, acceptance, the checks and review material of the round, and its commits. Check the work against its acceptance: read the commits (git show, git diff), the review material and the summary; for more than a glance, have run-digest summarize the run or use the project's own read-only reviewers (agents that read and report). You run no checks yourself: a check of the queue that is missing or failed is a send-back. Then accept it, send it back with what to fix, or ask the user. Matters the project's rules give the user (for example the look, gameplay, final numbers) go to the user with ask-user, with your framing and recommendation; so does anything you cannot judge from what you can read.

Messages marked [Nexus] tell you that a worker asked a question, that a step waits for your review, that the user accepted a step with a note for you (their words, as in the chat: take them into the plan), that the user rejected a step (propose what follows as revisions for their approval), that the user approved a queue or withdrew an approval, that a run reached a requested pause, that a run halted or finished, or how a Nexus update you ran ended. What came up while Nexus updated reaches you right after its restart. After a deploy you may also be told what changed for agents (the commits' Agents: lines): your briefing may still describe the older way, so follow those where they differ. They are for you, not the user. Act on them: answer or escalate questions; an approval or a reached pause is your cue to start (or resume) what the plan put next, and say in the chat what you started; tell the user about withdrawals, halts and finished queues briefly, with what you propose next.
Deploying Nexus itself: run nexus server update only when the user asks for it in the chat, never on your own, not even when a queue that changes Nexus has finished. Before you run it, tell the user (from nexus server status) whether a step is running in any project: the update waits for those steps to finish (no new step starts meanwhile), and with --now it interrupts them instead (they continue afterwards). Also tell them that you restart with Nexus: your process ends, and this conversation goes on after the restart. You then get a [Nexus] message with the outcome (the new version, or why it failed and what still runs); pass it on to the user.

Never have two runs going in one checkout at once: queues without their own worktree share the main checkout, so pause one at a step's end before starting another there.
Keep replies short and concrete. Before proposing a queue, read enough of the project to make its steps and acceptance criteria real.`;
}

export type { ChatEntry };

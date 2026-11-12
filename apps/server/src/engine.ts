// The queue engine: drives an approved queue step by step through a Nexus-launched session, delivers notes,
// messages and answers to live sessions, and records what the agent does. See docs/DESIGN.md, "Nexus drives the
// queue, step by step". All of its state is in files (run.yaml, runtime.json, delivered.jsonl, activity.jsonl);
// the processes are the only thing a restart loses, and a restart pauses the runs that had one.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ActionError, ProjectStore, USER_SESSION, ensureUserSession, loadProjectState, newId, normPath, now, readUsage,
  writeUsage, CLAUDE_EFFORTS, type Effort, type InboxView, type ProjectState, type QueueView, type RunFile, type SessionFile, type StepView,
} from "@nexus/protocol";
import type { AgentProcess, StreamFacts } from "./agent.ts";
import { ClaudeSession } from "./claude.ts";
import { CodexSession } from "./codex.ts";

interface Live { proc: AgentProcess; session: string }

export interface StartOptions { model?: string; effort?: Effort; session?: string; runtime?: "claude" | "codex" }

export class Engine {
  private readonly live = new Map<string, Live>();   // by Nexus session id
  private readonly store: ProjectStore;
  private readonly changed: () => void;
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();
  /** Set while Nexus drains for an update: nothing new starts. */
  draining = false;

  constructor(store: ProjectStore, changed: () => void) {
    this.store = store;
    this.changed = changed;
    this.recoverAfterRestart();
  }

  // ---------------------------------------------------------------- user actions

  start(queueId: string, opts: StartOptions = {}): RunFile {
    if (this.draining) throw new ActionError("Nexus is updating; start the queue after the restart", 409);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    if (!q.approved) throw new ActionError("approve the queue's current revision first", 409);
    if (q.run && ["running", "pausing", "usage_wait"].includes(q.run.state)) throw new ActionError("the queue is already running", 409);
    if (q.status === "done" || q.status === "cancelled") throw new ActionError(`the queue is ${q.status}`, 409);
    if (!q.steps.some((s) => s.status !== "done" && s.status !== "skipped")) throw new ActionError("no step left to run", 409);

    const session = opts.session
      ? this.reuseSession(state, opts.session, queueId, opts.model, opts.effort)
      : this.newSession(state, q, opts.runtime ?? state.project.runtimes.default, opts.model, opts.effort);
    const run: RunFile = { protocol: 1, session: session.id, state: "running", started_at: now(), updated_at: now() };
    this.store.writeRun(queueId, run);
    this.ensureProcess(session);
    this.advance(queueId);
    return run;
  }

  pause(queueId: string): void {
    const run = this.run(queueId);
    // Also a queue held for an update: the user's pause wins, so the restart does not resume it.
    if (run.state === "running" || run.state === "usage_wait" || run.resume_after_restart) {
      const working = this.live.get(run.session)?.proc.state === "working";
      this.writeRun(queueId, { ...run, state: working ? "pausing" : "paused", reason: "paused by the user", resume_after_restart: undefined });
    }
  }

  resume(queueId: string): void {
    const run = this.run(queueId);
    if (run.state === "running") return;
    if (run.state === "finished") throw new ActionError("the run is finished", 409);
    const state = loadProjectState(this.store);
    const q = this.queue(state, queueId);
    if (!q.approved) throw new ActionError("approve the queue's current revision first", 409);
    const session = this.sessionFile(state, run.session);
    this.ensureProcess(session);
    this.writeRun(queueId, { ...run, state: "running", reason: undefined, nudged: false, resume_after_restart: undefined });
    // A step left unfinished (stopped, failed, interrupted) is continued rather than skipped; one waiting for an
    // answer just waits on (the answer arrives through the inbox).
    const open = q.steps.find((s) => s.id === run.step && !["done", "skipped", "review"].includes(s.status));
    if (open?.status === "waiting") this.changed();
    else if (open) this.openStep(queueId, open, q, "continue");
    else this.advance(queueId);
  }

  // ---------------------------------------------------------------- updates of Nexus itself

  /**
   * Gets ready for a restart: running queues stop at the end of their current step (or at once with `now`) and are
   * marked to be resumed by the next server. Queues paused, halted, waiting for the usage window or pausing at the
   * user's request are left alone: a restart does not resume them.
   */
  drainForUpdate(now: boolean): string[] {
    this.draining = true;
    const held: string[] = [];
    for (const id of this.store.queueIds()) {
      const run = this.store.readRun(id);
      if (!run || run.state !== "running") continue;
      const working = this.live.get(run.session)?.proc.state === "working";
      const reason = "the Nexus server is updating; it goes on by itself afterwards";
      this.writeRun(id, { ...run, state: working && !now ? "pausing" : "paused", reason, resume_after_restart: true });
      held.push(id);
    }
    if (now) for (const [, l] of this.live) if (l.proc.state === "working") l.proc.kill();
    return held;
  }

  /** No agent of this project is in the middle of a turn. */
  idle(): boolean {
    return ![...this.live.values()].some((l) => l.proc.state === "working");
  }

  /** The update did not happen: the queues it held go on now. */
  cancelDrain(): void {
    this.draining = false;
    for (const id of this.store.queueIds()) {
      const run = this.store.readRun(id);
      if (!run?.resume_after_restart) continue;
      if (run.state === "pausing") this.writeRun(id, { ...run, state: "running", reason: undefined, resume_after_restart: undefined });
      else if (run.state === "paused") { try { this.resume(id); } catch (e) { this.halt(id, (e as Error).message); } }
    }
  }

  /** Interrupts the running turn and pauses the run. */
  stopNow(queueId: string, text?: string): void {
    const run = this.run(queueId);
    const live = this.live.get(run.session);
    this.writeRun(queueId, { ...run, state: "paused", reason: "stopped by the user", resume_after_restart: undefined });
    if (live && live.proc.state === "working") {
      live.proc.send(
        `[Nexus] The user asks you to stop now${text ? `: ${text}` : "."} Leave the work in a consistent state, record where you are with \`nexus step progress\`, and end your turn. Do not start anything new.`,
        "now",
      );
    }
  }

  acceptReview(queueId: string, step: string, text?: string): void {
    const state = loadProjectState(this.store);
    const st = this.queue(state, queueId).steps.find((s) => s.id === step);
    if (!st) throw new ActionError(`no step ${step}`, 404);
    if (st.status !== "review") throw new ActionError("the step is not waiting for review", 409);
    const user = ensureUserSession(this.store);
    this.store.appendEvent({ v: 1, id: newId(), at: now(), session: user.id, type: "review.accepted", queue: queueId, step, text });
    this.advance(queueId);
  }

  /** Called after every change to the project's files (debounced by the server). */
  onChange(state: ProjectState): void {
    for (const [, l] of this.live) this.deliverInbox(state, l);
    for (const q of state.queues) if (q.run && (q.run.state === "running" || q.run.state === "pausing")) this.advance(q.id, state);
  }

  /** Activity of a session, optionally only what was tagged with a step. */
  activity(session: string, queue?: string, step?: string, limit = 300) {
    const items = this.store.readActivity(session).entries.filter((a) => (!queue || a.queue === queue) && (!step || a.step === step));
    return items.slice(-limit);
  }

  shutdown(): void {
    for (const [, l] of this.live) l.proc.kill();
  }

  // ---------------------------------------------------------------- driving

  /**
   * Looks at the run's current step after anything happened and decides what comes next. Opens a turn only when
   * the session is idle, so it is safe to call at any time and any number of times.
   */
  private advance(queueId: string, given?: ProjectState): void {
    if (this.busy.has(queueId)) { setTimeout(() => this.advance(queueId), 50); return; }
    this.busy.add(queueId);
    try { this.advanceUnlocked(queueId, given); }
    catch (err) { this.halt(queueId, `engine error: ${(err as Error).message}`); }
    finally { this.busy.delete(queueId); }
  }

  private advanceUnlocked(queueId: string, given?: ProjectState): void {
    const run = this.store.readRun(queueId);
    if (!run || (run.state !== "running" && run.state !== "pausing")) return;
    const state = given ?? loadProjectState(this.store);
    const q = this.queue(state, queueId);
    const live = this.live.get(run.session);
    if (!live || live.proc.state === "exited") return this.halt(queueId, "the session's process is not running");
    if (live.proc.state === "working") return;
    if (!q.approved) return this.halt(queueId, "the queue's revision changed and is not approved");

    const current = run.step ? q.steps.find((s) => s.id === run.step) : undefined;
    if (q.status === "stopped") return this.halt(queueId, q.status_reason ?? "a stop condition was met");
    if (current) {
      switch (current.status) {
        case "running":
        case "pending": {
          // Something for the agent is on its way (a message, or an answer not yet routed to its inbox): the next
          // turn brings it, so this is not a turn without an outcome.
          const s = state.sessions.find((x) => x.id === run.session);
          const unread = s?.inbox.some((m) => !m.read_at);
          const unrouted = state.questions.some((x) => x.session === run.session && x.state === "answered"
            && !s?.inbox.some((m) => m.type === "answer" && m.qid === x.qid));
          if (unread || unrouted) return;
          // The turn ended and the step has no outcome: ask once, then hand it to the user.
          if (run.nudged) return this.halt(queueId, `step ${current.id} ended twice without an outcome`);
          this.writeRun(queueId, { ...run, nudged: true });
          live.proc.send(`[Nexus] Your turn ended, but step ${current.id} has no outcome yet. Continue the step if work remains; otherwise report it with \`nexus step done ${current.id} --summary "…"\`, \`nexus step failed\`, \`nexus stop\`, or ask with \`nexus ask\` and end your turn.`);
          return;
        }
        case "waiting":
          return; // a blocking question: its answer arrives through the inbox and starts the next turn
        case "review":
          return; // waits for the user's acceptance (review policy "wait")
        case "failed":
        case "stopped":
          return this.halt(queueId, `step ${current.id} ${current.status}${current.reason ? `: ${current.reason}` : ""}`);
        default:
          break; // done or skipped: go on
      }
    }

    if (run.state === "pausing") return this.writeRun(queueId, { ...run, state: "paused" });
    const next = q.steps.find((s) => s.status === "pending");
    if (!next) {
      this.writeRun(queueId, { ...run, state: "finished", reason: undefined });
      live.proc.close();
      return;
    }
    const wait = this.usageWait(state, this.sessionFile(state, run.session).runtime);
    if (wait) {
      this.writeRun(queueId, { ...run, state: "usage_wait", reason: wait.reason, resume_at: wait.until });
      this.scheduleResume(queueId, wait.until);
      return;
    }
    this.openStep(queueId, next, q, "start");
  }

  private openStep(queueId: string, step: StepView, q: QueueView, mode: "start" | "continue"): void {
    const run = this.run(queueId);
    const live = this.live.get(run.session);
    if (!live) return this.halt(queueId, "the session's process is not running");
    const state = loadProjectState(this.store);
    const project = state.project;
    const notes = step.notes.filter((n) => !n.read_at);
    const answers = state.questions.filter((x) => x.session === run.session && x.step === step.id && x.state === "answered");
    const last = !q.steps.some((s) => s.status === "pending" && s.id !== step.id);
    const index = q.steps.findIndex((s) => s.id === step.id);
    const lines = [
      `[Nexus] Queue ${q.id} "${q.title}" (revision ${q.revision}, approved), step ${step.id} (${index + 1} of ${q.steps.length}): ${step.title}.`,
      mode === "continue" ? `Continue this step where it was left${step.reason ? ` (it was left: ${step.reason})` : ""}.` : "",
      step.goal ? `\nGoal:\n${step.goal}` : "",
      step.acceptance.length ? `\nAcceptance:\n${step.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
      q.checks.length ? `\nChecks for every step:\n${q.checks.map((c) => `- ${c}`).join("\n")}` : "",
      step.review?.prepare ? `\nReview to prepare: ${step.review.prepare}` : "",
      `\nStop conditions (meeting one ends the queue: report it with \`nexus stop\`):\n${[...q.stop_conditions, ...project.defaults.stop_conditions].map((c) => `- ${c}`).join("\n") || "- none beyond your judgement"}`,
      notes.length ? `\nNotes from the user for this step:\n${notes.map((n) => `- ${n.body}`).join("\n")}` : "",
      answers.length ? `\nAnswers to your questions about this step:\n${answers.map((x) => `- "${x.text}": ${x.answers.at(-1)?.text}`).join("\n")}` : "",
      `\nBegin with \`nexus step start ${step.id}\`${mode === "continue" ? " (again is fine)" : ""}. End with \`nexus step done ${step.id} --summary "…"\`, \`nexus step failed\` or \`nexus stop\`, then write \`nexus context\` and end your turn. Do not start another step.`,
      last ? `\nThis is the queue's last step. After it is done, write a short report of the whole queue (what each step achieved against its acceptance, checks, review material, open questions, a proposed next step) to ${join(this.store.queueDir(q.id), "report.md").replaceAll("\\", "/")} and register it with \`nexus report ${q.id} --file <that path> --summary "…"\`.` : "",
    ].filter(Boolean);
    live.proc.send(lines.join("\n"));
    for (const n of notes) this.store.appendDelivered(run.session, { at: now(), kind: "note", id: n.id, via: "turn" });
    this.writeRun(queueId, { ...run, step: step.id, nudged: false });
    this.store.appendActivity(run.session, { at: now(), kind: "turn_start", text: `Nexus opened step ${step.id}${mode === "continue" ? " (continue)" : ""}`, queue: queueId, step: step.id });
  }

  /** Hands unread inbox entries to a live session: inside a running turn, or as a new turn when it is idle. */
  private deliverInbox(state: ProjectState, l: Live): void {
    if (l.proc.state === "exited") return;
    const s = state.sessions.find((x) => x.id === l.session);
    const unread = (s?.inbox ?? []).filter((m) => !m.read_at);
    if (!unread.length) return;
    const run = state.queues.find((q) => q.run?.session === l.session)?.run;
    const idleAllowed = !run || run.state === "running" || run.state === "pausing";
    for (const m of unread) {
      const text = formatInbox(m, state);
      if (m.type === "stop") l.proc.send(text, "now");
      else if (l.proc.state === "working") l.proc.send(text, "next");
      else if (idleAllowed) l.proc.send(text);
      else continue; // a paused run: keep it for later
      this.store.appendDelivered(l.session, { at: now(), kind: "inbox", id: m.id, via: l.proc.state === "working" ? "inject" : "turn" });
    }
  }

  private halt(queueId: string, reason: string): void {
    const run = this.store.readRun(queueId);
    if (!run || run.state === "halted") return;
    this.writeRun(queueId, { ...run, state: "halted", reason, resume_after_restart: undefined });
  }

  // ---------------------------------------------------------------- sessions and processes

  private newSession(state: ProjectState, q: QueueView, runtime: "claude" | "codex", model?: string, effort?: Effort): SessionFile {
    if (runtime === "claude" && effort && !CLAUDE_EFFORTS.includes(effort)) throw new ActionError(`Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}`);
    const cwd = this.worktreeFor(state, q);
    const s: SessionFile = {
      protocol: 1, id: newId(), project: state.project.id, role: "worker", runtime,
      // Claude takes the id Nexus chooses; Codex assigns its thread id when the thread starts.
      native_id: runtime === "claude" ? randomUUID() : null,
      title: `${q.id} worker`, cwd, branch: gitBranch(cwd), queue: q.id, launched_by: "nexus", created_at: now(),
      model: model ?? state.project.runtimes[runtime].model,
      effort: effort ?? state.project.runtimes[runtime].effort,
    };
    this.store.writeSession(s);
    return s;
  }

  private reuseSession(state: ProjectState, id: string, queueId: string, model?: string, effort?: Effort): SessionFile {
    const s = this.sessionFile(state, id);
    if (s.runtime === "external" || s.launched_by !== "nexus" || !s.native_id) throw new ActionError("only a session Nexus launched (and started at least once) can be continued", 409);
    const busy = state.queues.find((q) => q.id !== queueId && q.run?.session === id && ["running", "pausing", "usage_wait"].includes(q.run.state));
    if (busy) throw new ActionError(`that session is running queue ${busy.id}`, 409);
    if (s.runtime === "claude" && effort && !CLAUDE_EFFORTS.includes(effort)) throw new ActionError(`Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}`);
    const updated: SessionFile = { ...s, queue: queueId, model: model ?? s.model, effort: effort ?? s.effort };
    this.store.writeSession(updated);
    return updated;
  }

  private ensureProcess(session: SessionFile): Live {
    const existing = this.live.get(session.id);
    if (existing && existing.proc.state !== "exited") return existing;
    const project = this.store.readProject();
    const env = { NEXUS_SESSION: session.id, NEXUS_DIR: this.store.dir };
    let proc: AgentProcess;
    if (session.runtime === "codex") {
      const codex = project.runtimes.codex;
      const inside = normPath(this.store.dir).toLowerCase().startsWith(normPath(session.cwd).toLowerCase() + "/");
      proc = new CodexSession({
        cwd: session.cwd, model: session.model ?? codex.model, effort: session.effort ?? codex.effort, instructions: WORKER_BRIEFING, env,
        threadId: session.native_id, sandbox: codex.sandbox, approvalPolicy: codex.approval_policy, approvalsReviewer: codex.approvals_reviewer,
        writableRoots: inside ? [] : [this.store.dir],
      });
    } else {
      const claude = project.runtimes.claude;
      const transcriptExists = this.store.readRuntime(session.id) !== undefined; // started before: resume it
      proc = new ClaudeSession({
        cwd: session.cwd,
        uuid: session.native_id!,
        resume: transcriptExists,
        model: session.model ?? claude.model,
        effort: session.effort ?? claude.effort,
        permissionMode: claude.permission_mode,
        allowedTools: ["Bash(nexus:*)", ...claude.allowed_tools],
        appendSystemPrompt: WORKER_BRIEFING,
        env,
      });
    }
    const l: Live = { proc, session: session.id };
    this.live.set(session.id, l);
    this.writeRuntime(session.id, { state: "idle", pid: proc.pid });

    const tag = () => {
      const run = this.store.queueIds().map((q) => [q, this.store.readRun(q)] as const).find(([, r]) => r?.session === session.id);
      return run ? { queue: run[0], step: run[1]?.step } : {};
    };
    proc.on("activity", (a) => this.store.appendActivity(session.id, { at: now(), ...a, ...tag() }));
    proc.on("facts", (f) => this.facts(session.id, f));
    proc.on("turnEnd", () => {
      this.writeRuntime(session.id, { state: "idle", turns: (this.store.readRuntime(session.id)?.turns ?? 0) + 1 });
      // Let the CLI's last events land in the files, then decide.
      setTimeout(() => { for (const q of this.store.queueIds()) if (this.store.readRun(q)?.session === session.id) this.advance(q); this.changed(); }, 300);
    });
    proc.on("exit", (code) => {
      this.writeRuntime(session.id, { state: "exited" });
      this.store.appendActivity(session.id, { at: now(), kind: code === 0 ? "exit" : "error", text: `process exited (${code ?? "signal"})`, ...tag() });
      if (this.live.get(session.id) === l) this.live.delete(session.id);
      for (const q of this.store.queueIds()) {
        const run = this.store.readRun(q);
        if (run?.session === session.id && (run.state === "running" || run.state === "pausing")) this.halt(q, `the session's process exited (${code ?? "signal"})`);
      }
      this.changed();
    });
    return l;
  }

  private facts(session: string, f: StreamFacts): void {
    const patch: Record<string, unknown> = {};
    if (f.model) patch.model = f.model;
    if (f.contextTokens !== undefined) patch.context_tokens = f.contextTokens;
    if (f.contextWindow) patch.context_window = f.contextWindow;
    if (f.costUsd !== undefined) patch.cost_usd = f.costUsd;
    if (f.contextTokens !== undefined || f.model) patch.state = "working";
    if (Object.keys(patch).length) this.writeRuntime(session, patch);
    if (f.usage) writeUsage({ updated_at: now(), windows: { ...readUsage()?.windows, ...f.usage } });
    if (f.nativeId) {
      const s = this.store.readSession(session);
      if (s.native_id !== f.nativeId) this.store.writeSession({ ...s, native_id: f.nativeId });
    }
  }

  private writeRuntime(session: string, patch: Record<string, unknown>): void {
    const old = this.store.readRuntime(session);
    this.store.writeRuntime(session, { turns: 0, state: "idle", ...old, ...patch, updated_at: now() } as never);
  }

  /** A queue's working directory: its worktree (created when it says `auto`), else the project's checkout. */
  private worktreeFor(state: ProjectState, q: QueueView): string {
    if (q.worktree && q.worktree !== "auto") return normPath(q.worktree);
    if (q.worktree !== "auto") return normPath(state.project.root);
    const root = state.project.root;
    const dir = normPath(state.project.defaults.worktree_dir ?? join(dirname(root), `${basename(root)}.worktrees`));
    const path = normPath(join(dir, q.id));
    const branch = q.branch ?? `nexus/${q.id}`;
    if (!existsSync(path)) {
      const exists = (() => { try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root, stdio: "ignore" }); return true; } catch { return false; } })();
      const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, q.base ?? "HEAD"];
      try { execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { throw new ActionError(`could not create the worktree: ${(e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message}`, 500); }
    }
    this.store.writeQueue({ ...this.store.readQueue(q.id), worktree: path, branch, updated_at: now() });
    return path;
  }

  // ---------------------------------------------------------------- usage limits

  /** Claude's 5-hour window, or any of Codex's windows, above the project's threshold. */
  private usageWait(state: ProjectState, runtime: string): { reason: string; until: string } | undefined {
    const windows = readUsage()?.windows ?? {};
    const names = runtime === "codex" ? Object.keys(windows).filter((k) => k.startsWith("codex_")) : ["five_hour"];
    const limit = state.project.defaults.usage_pause_threshold;
    for (const name of names) {
      const w = windows[name];
      if (!w || !w.resets_at || Date.parse(w.resets_at) < Date.now() || w.utilization < limit) continue;
      return { reason: `the ${name.replace("codex_", "Codex ").replace("five_hour", "5-hour")} window is at ${Math.round(w.utilization * 100)} % (limit ${Math.round(limit * 100)} %)`, until: w.resets_at };
    }
    return undefined;
  }

  private scheduleResume(queueId: string, until: string): void {
    clearTimeout(this.timers.get(queueId));
    const ms = Math.max(1000, Date.parse(until) - Date.now() + 60_000);
    this.timers.set(queueId, setTimeout(() => {
      const run = this.store.readRun(queueId);
      if (run?.state === "usage_wait") { this.writeRun(queueId, { ...run, state: "running", reason: undefined }); this.advance(queueId); }
    }, ms));
  }

  // ---------------------------------------------------------------- helpers

  private recoverAfterRestart(): void {
    for (const q of this.store.queueIds()) {
      const run = this.store.readRun(q);
      if (run?.resume_after_restart) {
        // Held for an update: resumed shortly, once this server is up.
        this.writeRun(q, { ...run, state: "paused", reason: "resuming after the Nexus update" });
        setTimeout(() => {
          const r = this.store.readRun(q);
          if (!r?.resume_after_restart) return;
          try { this.resume(q); } catch (e) { this.halt(q, `could not resume after the update: ${(e as Error).message}`); }
          this.changed();
        }, 1500);
      } else if (run && ["running", "pausing"].includes(run.state)) {
        this.writeRun(q, { ...run, state: "paused", reason: "the Nexus server restarted; resume to continue" });
      }
      if (run?.state === "usage_wait" && run.resume_at) this.scheduleResume(q, run.resume_at);
    }
    for (const s of this.store.sessionIds()) {
      const r = this.store.readRuntime(s);
      if (!r || r.state === "exited") continue;
      // A process the previous server left behind (killed without its shutdown) would write into the same
      // session as the one a resume starts: end it first.
      if (r.pid && isAlive(r.pid)) { try { process.kill(r.pid); } catch { /* gone or not ours */ } }
      this.writeRuntime(s, { state: "exited" });
    }
  }

  private run(queueId: string): RunFile {
    const run = this.store.readRun(queueId);
    if (!run) throw new ActionError("the queue has no run", 409);
    return run;
  }

  private writeRun(queueId: string, run: RunFile): void {
    this.store.writeRun(queueId, { ...run, updated_at: now() });
  }

  private queue(state: ProjectState, id: string): QueueView {
    const q = state.queues.find((x) => x.id === id);
    if (!q) throw new ActionError(`unknown queue ${id}`, 404);
    return q;
  }

  private sessionFile(state: ProjectState, id: string): SessionFile {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.id === USER_SESSION) throw new ActionError(`unknown session ${id}`, 404);
    return s;
  }
}

function formatInbox(m: InboxView, state: ProjectState): string {
  if (m.type === "answer") {
    const q = state.questions.find((x) => x.qid === m.qid);
    const how = m.continue === false ? " Wait for further word before going on." : "";
    return `[Nexus] Answer from the ${m.from} to your question${q ? ` "${q.text}"` : ""}:\n${m.text}${how}`;
  }
  if (m.type === "message") return `[Nexus] Message from the ${m.from}${m.step ? ` about step ${m.step}` : ""}:\n${m.text}`;
  return `[Nexus] The ${m.from} asks you to stop now${m.text ? `: ${m.text}` : "."} Leave the work consistent and end your turn.`;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function gitBranch(cwd: string): string | null {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

const WORKER_BRIEFING = `You are a worker session run by Nexus, the dashboard through which the user follows and steers your work.
Nexus sends you one step of an approved queue at a time. Work on that step only; when its outcome is reported, end your turn: Nexus opens the next step.
Report through the \`nexus\` command (on PATH; your session is set in the environment as NEXUS_SESSION):
- nexus step start <step>                                   when you begin a step
- nexus step progress <step> "<short status>" [--pct N]     at milestones, so the user sees where you are
- nexus review add <step> <file|url>... --label "..."       review material (pictures, sheets, reports)
- nexus check <step> <name> --ok|--fail --summary "..."      results of the step's checks
- nexus step done <step> --summary "..." [--commit <sha>]   when the acceptance criteria are met
- nexus step failed <step> --reason "..."                   when the step cannot be done as written
- nexus stop <step> --condition "..." --reason "..."        when a stop condition is met
- nexus ask "<question>" --step <step> [--can-continue]     a question for the orchestrator or the user; without --can-continue, end your turn after asking: the answer arrives as a message
- nexus context "<what a successor needs to know>" --topics a,b --files x,y   at the end of each step
Messages from the user may arrive while you work, marked [Nexus]; follow them.`;


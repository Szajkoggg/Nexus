// The project's orchestrator: one long-lived Claude Code session the user talks with in the dashboard. It plans
// queues and launches runs through `nexus` (queue.drafted, session.request), answers or escalates workers'
// questions, and is told when a worker asks or a run halts or finishes. It may read everything and edit nothing:
// permission mode dontAsk with a read-only allow list.
import { randomUUID } from "node:crypto";
import {
  ActionError, ProjectStore, applyDraft, loadProjectState, newId, now, type ChatEntry, type Event, type ProjectState, type SessionFile,
} from "@nexus/protocol";
import { ClaudeSession } from "./claude.ts";
import type { Engine } from "./engine.ts";

const READ_ONLY_TOOLS = [
  "Read", "Grep", "Glob", "Bash(nexus:*)",
  "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git branch:*)", "Bash(git worktree list:*)",
];
const NEVER = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

export class Orchestrator {
  private proc?: ClaudeSession;
  private readonly store: ProjectStore;
  private readonly engine: Engine;
  private readonly changed: () => void;
  private applying = false;

  constructor(store: ProjectStore, engine: Engine, changed: () => void) {
    this.store = store;
    this.engine = engine;
    this.changed = changed;
  }

  /** The current orchestrator session, if one was ever started. */
  session(): SessionFile | undefined {
    const id = this.store.readProject().orchestrator?.session;
    if (!id) return undefined;
    try { return this.store.readSession(id); } catch { return undefined; }
  }

  view() {
    const s = this.session();
    return {
      session: s ?? null,
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
    this.deliver(text.trim());
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
    const s = this.session();
    if (!s) return;
    this.applyRequests(s);
    if (state.project.orchestrator?.notify === false) return;
    this.notify(state, s);
  }

  shutdown(): void { this.proc?.kill(); }

  // ---------------------------------------------------------------- the session

  private ensure(): SessionFile {
    let s = this.session();
    const project = this.store.readProject();
    if (!s) {
      s = {
        protocol: 1, id: newId(), project: project.id, role: "orchestrator", runtime: "claude", native_id: randomUUID(),
        title: "Orchestrator", cwd: project.root, launched_by: "nexus", created_at: now(), model: project.orchestrator?.model,
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
      cwd: s.cwd, uuid: s.native_id!, resume, model: s.model,
      permissionMode: "dontAsk",
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: NEVER,
      appendSystemPrompt: briefing(project.name, Math.round(project.defaults.context_reuse_threshold * 100)),
      env: { NEXUS_SESSION: s.id, NEXUS_DIR: this.store.dir },
    });
    this.proc = proc;
    this.runtime(s.id, { state: "idle", pid: proc.pid });
    proc.on("activity", (a) => {
      if (a.kind === "text") this.store.appendChat(s.id, { at: now(), from: "orchestrator", text: a.text });
      else if (a.kind === "tool") this.store.appendChat(s.id, { at: now(), from: "orchestrator", kind: "tool", text: a.text });
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
    proc.on("turnEnd", () => { this.runtime(s.id, { state: "idle" }); this.changed(); });
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
      const pending = this.store.readEvents(s.id).entries.filter((e) => (e.type === "queue.drafted" || e.type === "session.request") && !done.has(e.id));
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
    if (e.type !== "session.request") return "ignored";
    switch (e.action) {
      case "start": {
        const run = this.engine.start(e.queue, { session: e.use_session, model: e.model, runtime: e.runtime });
        return `queue ${e.queue} started in session ${run.session}`;
      }
      case "pause": this.engine.pause(e.queue); return `queue ${e.queue} pauses after its current step`;
      case "resume": this.engine.resume(e.queue); return `queue ${e.queue} resumed`;
      case "stop": this.engine.stopNow(e.queue, e.reason); return `queue ${e.queue} stopped`;
    }
  }

  // ---------------------------------------------------------------- what the orchestrator is told

  private notify(state: ProjectState, s: SessionFile): void {
    const told = new Set(this.store.readApplied(s.id).entries.map((a) => a.event));
    const since = s.created_at;
    const items: { key: string; text: string }[] = [];
    for (const x of state.questions) {
      const asker = state.sessions.find((y) => y.id === x.session);
      if (x.state !== "open" || asker?.role !== "worker" || x.asked_at < since) continue;
      items.push({
        key: `notify:question:${x.qid}`,
        text: `[Nexus] A worker asked a question${x.queue ? ` in queue ${x.queue}${x.step ? `, step ${x.step}` : ""}` : ""} (qid ${x.qid}; ${x.can_continue ? "it goes on meanwhile" : "it waits for the answer"}):\n${x.text}${x.options?.length ? `\nOptions: ${x.options.join(" / ")}` : ""}\nAnswer it if the answer is settled, otherwise escalate it to the user.`,
      });
    }
    for (const q of state.queues) {
      const r = q.run;
      if (!r || (r.state !== "halted" && r.state !== "finished") || r.updated_at < since) continue;
      items.push({
        key: `notify:run:${q.id}:${r.state}:${r.updated_at}`,
        text: r.state === "halted"
          ? `[Nexus] The run of queue ${q.id} halted at step ${r.step ?? "?"}: ${r.reason ?? "no reason given"}. Tell the user briefly, with what you propose.`
          : `[Nexus] Queue ${q.id} finished.${q.report ? ` Report: ${q.report.summary}` : ""} Tell the user briefly, with what you propose next.`,
      });
    }
    const fresh = items.filter((i) => !told.has(i.key));
    if (!fresh.length) return;
    this.ensure();
    for (const i of fresh) {
      this.store.appendApplied(s.id, { at: now(), event: i.key, ok: true, message: "told" });
      // The user sees the fact; the instruction after it is for the orchestrator only.
      const shown = i.text.replace(/^\[Nexus\] /, "").replace(/\s*(Answer it if|Tell the user)[\s\S]*$/, "");
      this.store.appendChat(s.id, { at: now(), from: "nexus", text: shown });
      this.deliver(i.text);
    }
  }
}

function briefing(project: string, threshold: number): string {
  return `You are the orchestrator of the project "${project}" in Nexus, the user's dashboard for AI-driven work. The user talks with you in the dashboard's chat; reply in the language they write in. Everything you write into files or queues is in English.

Your job: plan the work with the user as queues of steps, keep the queues and their runs moving, and keep the user informed. You plan and launch; you never do the project's work yourself.
- You may read the project (its files, documentation, git history) and everything under .nexus/.
- You may not edit files, approve queues (only the user approves, in the dashboard), or answer a question that is the user's to decide by the project's rules (for example the look, gameplay, final numbers). Escalate those, with your framing and a recommendation.

Commands (\`nexus\` is on PATH; your session is set in the environment):
- nexus status                                   every queue, step, run, open question and session, with context cards
- nexus queue draft - <<'EOF' ... EOF            create or change a queue from YAML (format below); a new or changed queue waits for the user's approval
- nexus run <queue> start --reason "..." [--use-session <id>] [--runtime claude|codex] [--model <model>]   start an approved queue (--use-session continues an existing session; the runtime defaults to the project's)
- nexus run <queue> pause|resume|stop --reason "..."
- nexus answer <qid> "<answer>" [--continue|--wait]            answer a worker's question whose answer is already settled
- nexus answer <qid> "<framing, options, recommendation>" --escalate   pass it to the user

Queue YAML (all text in English):
id: W                          # short, unique in the project
title: Variant B made a system
description: |                 # optional: context the worker needs
  ...
worktree: auto                 # optional: auto = Nexus creates a worktree and branch; or a path; omitted = the main checkout
branch: v2/cliffs              # optional
review_policy: continue        # optional: continue (default) or wait (hold after each step for the user)
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
      policy: wait             # optional, this step only

Choosing a session for a run: \`nexus status\` shows each session's context card (topics, files, context fill). Continue a session (--use-session) when it worked on closely related things and its context is below ${threshold} %; otherwise start a fresh one and put what it needs into the queue's description and goals. Never give one session two running queues.

Messages marked [Nexus] tell you that a worker asked a question, or that a run halted or finished. Act on them: answer or escalate questions; tell the user about halts and finished queues briefly, with what you propose next.
Keep replies short and concrete. Before proposing a queue, read enough of the project to make its steps and acceptance criteria real.`;
}

export type { ChatEntry };

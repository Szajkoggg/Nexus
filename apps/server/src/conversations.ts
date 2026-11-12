// Conversations: thinking partners the user talks with about a project (gameplay design, ideas), one session per
// thread. They read the whole project and write only in its notes folder; they start no work. A conversation can
// be handed to the orchestrator: the partner writes a summary, which goes into the orchestrator's chat.
//
// Writing only in the notes folder: Claude Code runs in `dontAsk` mode with `Edit(<notes>/**)` as the only write
// rule (checked: writes elsewhere and shell writes are refused). Codex runs with the notes folder as its working
// directory in a `workspace-write` sandbox, which reads everywhere and writes only there; it is never asked.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ActionError, CLAUDE_EFFORTS, Effort, ProjectStore, newId, normPath, now, type ProjectFile, type SessionFile,
} from "@nexus/protocol";
import type { AgentProcess } from "./agent.ts";
import { ClaudeSession } from "./claude.ts";
import { CodexSession } from "./codex.ts";
import type { Orchestrator } from "./orchestrator.ts";

const READ = ["Read", "Grep", "Glob", "Bash(nexus status:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)"];
const IDLE_MS = 15 * 60_000; // an idle partner's process ends; the next message resumes the conversation

interface Live { proc: AgentProcess; timer?: NodeJS.Timeout; handoff?: boolean }

export class Conversations {
  private readonly store: ProjectStore;
  private readonly orchestrator: Orchestrator;
  private readonly changed: () => void;
  private readonly live = new Map<string, Live>();
  /** Set while Nexus drains for an update: no new turn starts. */
  draining = false;

  constructor(store: ProjectStore, orchestrator: Orchestrator, changed: () => void) {
    this.store = store;
    this.orchestrator = orchestrator;
    this.changed = changed;
  }

  list() {
    return this.store.sessionIds()
      .map((id) => { try { return this.store.readSession(id); } catch { return undefined; } })
      .filter((s): s is SessionFile => s?.role === "conversation")
      .map((s) => {
        const chat = this.store.readChat(s.id).entries;
        return { ...s, state: this.live.get(s.id)?.proc.state ?? "exited", last_at: chat.at(-1)?.at ?? s.created_at, messages: chat.filter((c) => c.kind === "message").length };
      })
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.last_at.localeCompare(a.last_at));
  }

  view(id: string) {
    const s = this.session(id);
    return { session: s, state: this.live.get(id)?.proc.state ?? "exited", runtime: this.store.readRuntime(id) ?? null, chat: this.store.readChat(id).entries.slice(-400), model: s.model ?? null, effort: s.effort ?? null, notes_dir: this.store.readProject().conversations.notes_dir ?? null };
  }

  create(body: { title?: unknown; runtime?: unknown; model?: unknown; effort?: unknown }): SessionFile {
    const p = this.store.readProject();
    const c = p.conversations;
    const runtime = body.runtime === "codex" || body.runtime === "claude" ? body.runtime : c.runtime;
    const effort = parseEffort(body.effort) ?? c.effort;
    if (runtime === "claude" && effort && !CLAUDE_EFFORTS.includes(effort)) throw new ActionError(`Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}`);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "New conversation";
    const s: SessionFile = {
      protocol: 1, id: newId(), project: p.id, role: "conversation", runtime, title,
      native_id: runtime === "claude" ? randomUUID() : null, cwd: normPath(p.root), launched_by: "nexus", created_at: now(),
      model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : c.model, effort,
    };
    this.store.writeSession(s);
    this.changed();
    return s;
  }

  update(id: string, body: { title?: unknown; model?: unknown; effort?: unknown; archived?: unknown }): void {
    const s = this.session(id);
    const next = { ...s };
    if (typeof body.title === "string" && body.title.trim()) next.title = body.title.trim().slice(0, 120);
    if (body.model !== undefined) next.model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    if (body.effort !== undefined) next.effort = parseEffort(body.effort);
    if (typeof body.archived === "boolean") next.archived = body.archived;
    if (next.runtime === "claude" && next.effort && !CLAUDE_EFFORTS.includes(next.effort)) throw new ActionError(`Claude Code takes effort ${CLAUDE_EFFORTS.join(", ")}`);
    this.store.writeSession(next);
    // A new model or effort applies from the next message: the process restarts (the conversation goes on).
    if (next.model !== s.model || next.effort !== s.effort) this.retire(id);
    this.changed();
  }

  say(id: string, text: unknown): void {
    if (typeof text !== "string" || !text.trim()) throw new ActionError("the message is empty");
    if (this.draining) throw new ActionError("Nexus is updating; send it after the restart", 409);
    const s = this.session(id);
    this.store.appendChat(id, { at: now(), from: "user", text: text.trim() });
    this.deliver(s, text.trim());
  }

  /** The partner summarizes the conversation; the summary then goes to the orchestrator's chat. */
  handoff(id: string): void {
    if (this.draining) throw new ActionError("Nexus is updating; try after the restart", 409);
    const s = this.session(id);
    this.store.appendChat(id, { at: now(), from: "nexus", text: "Summarizing this conversation for the orchestrator…" });
    const l = this.ensure(s);
    l.handoff = true;
    this.deliver(s, `[Nexus] The user hands this conversation to the orchestrator, who plans and runs work in queues. Write a summary for it, in English: what was decided (only what the user decided), the open questions, the work you propose (as steps with what each should achieve), and the files where the notes are. Reply with the summary only.`);
  }

  idle(): boolean { return ![...this.live.values()].some((l) => l.proc.state === "working"); }

  shutdown(): void { for (const l of this.live.values()) { clearTimeout(l.timer); l.proc.kill(); } }

  // ---------------------------------------------------------------- processes

  private session(id: string): SessionFile {
    let s: SessionFile;
    try { s = this.store.readSession(id); } catch { throw new ActionError("no such conversation", 404); }
    if (s.role !== "conversation") throw new ActionError("no such conversation", 404);
    return s;
  }

  private deliver(s: SessionFile, text: string): void {
    const l = this.ensure(s);
    clearTimeout(l.timer);
    l.proc.send(text, l.proc.state === "working" ? "next" : undefined);
    this.changed();
  }

  private retire(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    clearTimeout(l.timer);
    if (l.proc.state === "working") { l.proc.close(); } else { l.proc.kill(); }
    this.live.delete(id);
  }

  private ensure(s: SessionFile): Live {
    const existing = this.live.get(s.id);
    if (existing && existing.proc.state !== "exited") return existing;
    const p = this.store.readProject();
    const notes = p.conversations.notes_dir;
    const env = { NEXUS_SESSION: s.id, NEXUS_DIR: this.store.dir };
    const instructions = briefing(p, notes);
    let proc: AgentProcess;
    if (s.runtime === "codex") {
      // Its working directory is the notes folder: the sandbox writes only there. Without one it is read-only.
      const cwd = notes ? join(p.root, notes) : p.root;
      if (notes) mkdirSync(cwd, { recursive: true });
      proc = new CodexSession({
        cwd, model: s.model, effort: s.effort, instructions, env, threadId: s.native_id,
        sandbox: notes ? "workspace-write" : "read-only", approvalPolicy: "never", writableRoots: [],
      });
    } else {
      proc = new ClaudeSession({
        cwd: p.root, uuid: s.native_id!, resume: this.store.readRuntime(s.id) !== undefined,
        model: s.model, effort: s.effort, permissionMode: "dontAsk",
        allowedTools: notes ? [...READ, `Edit(${notes}/**)`] : READ,
        disallowedTools: ["NotebookEdit"],
        appendSystemPrompt: instructions, env,
      });
    }
    const l: Live = { proc };
    this.live.set(s.id, l);
    this.runtime(s.id, { state: "idle", pid: proc.pid });
    // The partner's last text of the turn, whole: during a hand-over, the summary.
    let reply = "";
    proc.on("message", (text) => { reply = text; if (!l.handoff) this.store.appendChat(s.id, { at: now(), from: "partner", text }); });
    proc.on("activity", (a) => {
      if (a.kind === "tool") this.store.appendChat(s.id, { at: now(), from: "partner", kind: "tool", text: a.text });
      else if (a.kind === "error") this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: a.text });
      else if (a.kind === "turn_start") reply = "";
    });
    proc.on("facts", (f) => {
      const patch: Record<string, unknown> = {};
      if (f.model) patch.model = f.model;
      if (f.contextTokens !== undefined) { patch.context_tokens = f.contextTokens; patch.state = "working"; }
      if (f.contextWindow) patch.context_window = f.contextWindow;
      if (f.nativeId && f.nativeId !== s.native_id) this.store.writeSession({ ...this.store.readSession(s.id), native_id: f.nativeId });
      if (Object.keys(patch).length) this.runtime(s.id, patch);
    });
    proc.on("turnEnd", () => {
      this.runtime(s.id, { state: "idle" });
      if (l.handoff) {
        l.handoff = false;
        const summary = reply.trim();
        if (summary) {
          this.store.appendChat(s.id, { at: now(), from: "partner", text: summary });
          try {
            this.orchestrator.say(`[From the conversation "${this.session(s.id).title}"]\n\n${summary}`);
            this.store.appendChat(s.id, { at: now(), from: "nexus", text: "The summary went to the orchestrator's chat." });
          } catch (e) { this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: `Could not hand it over: ${(e as Error).message}` }); }
        }
      }
      clearTimeout(l.timer);
      l.timer = setTimeout(() => { if (l.proc.state !== "working") { l.proc.kill(); this.live.delete(s.id); this.changed(); } }, IDLE_MS);
      this.changed();
    });
    proc.on("exit", () => { this.runtime(s.id, { state: "exited" }); if (this.live.get(s.id) === l) this.live.delete(s.id); this.changed(); });
    return l;
  }

  private runtime(id: string, patch: Record<string, unknown>): void {
    const old = this.store.readRuntime(id);
    this.store.writeRuntime(id, { turns: 0, state: "idle", ...old, ...patch, updated_at: now() } as never);
  }
}

function parseEffort(v: unknown): Effort | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const r = Effort.safeParse(v);
  if (!r.success) throw new ActionError(`effort is one of ${Effort.options.join(", ")}`);
  return r.data;
}

function briefing(p: ProjectFile, notes: string | undefined): string {
  return `You are a thinking partner for the project "${p.name}", in a conversation the user opened in Nexus to think something through: gameplay design, ideas, the direction of the project. Reply in the language the user writes in; anything you write into files is in English.

How to be useful here:
- Explore, ask, challenge, and propose alternatives with their trade-offs. Do not rush to a plan; a good question is often worth more than an answer.
- Ground what you say in the project: read its design documents, notes, decisions and history before you state anything about it, and say where you found it.
- Keep the user's decisions apart from ideas. Never write a proposal down as if it were decided.

The project's root is ${p.root.replaceAll("\\", "/")}; paths below are relative to it.

What you may do:
- Read anything in the project (and run \`nexus status\` to see its queues and runs, read-only git commands for its history).
${notes ? `- Write only in ${notes}/ (relative to the project's root): notes of what the user decides or asks you to record. Keep to the project's own conventions for that folder (its README or AGENTS.md). One file per topic, dated entries, decisions separate from open ideas.` : `- No notes folder is set for this project, so you cannot write files; the user can set one in the project's settings.`}
- You start no work: no builds, no tests, no code changes, no queues. When the user wants something done, suggest handing the conversation to the orchestrator (the "Hand to orchestrator" button); then you write the summary it asks for.`;
}

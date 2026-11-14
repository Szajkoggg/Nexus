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
  ActionError, Effort, ProjectStore, effortIssue, languageName, loadProjectState, newId, normPath, now, type SessionFile,
} from "@nexus/protocol";
import { findStep, sinceThen, stepSeed } from "./step-seed.ts";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Hosted, type Launch } from "./agent-host.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { partnerBriefing } from "./prompts.ts";
import { STOPPED, chatView } from "./chats.ts";

const READ = ["Read", "Grep", "Glob", "Bash(nexus status:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)"];
/** What a hand-over covers (decided 2026-11-14): this conversation's topics, and the dates of the decisions it passes on. */
export const HANDOFF_SCOPE = "Summarize only the topics discussed in this conversation, unless the user asked you to include others. From a notes file, pass on what this conversation decided or recorded; another topic in the notes folder, even a related one, is not part of this hand-over: name its file at most, as 'see also', without its content. In every notes file only the Decided section holds decisions. Name the dates of the Decided entries you cover.";
const IDLE_MS = 15 * 60_000; // an idle partner's process ends; the next message resumes the conversation

/** What a partner's process keeps beside it: its idle timer, and whether its running turn writes a hand-over. */
type Live = Hosted<{ timer?: NodeJS.Timeout; handoff?: boolean }>;

export class Conversations {
  private readonly store: ProjectStore;
  private readonly orchestrator: Orchestrator;
  private readonly changed: () => void;
  private readonly host: AgentHost<{ timer?: NodeJS.Timeout; handoff?: boolean }>;
  /** Set while Nexus drains for an update: no new turn starts. */
  draining = false;

  /** `host`: how the partners' processes are made (tests give a stand-in). */
  constructor(store: ProjectStore, orchestrator: Orchestrator, changed: () => void, host: AgentHostOptions = {}) {
    this.store = store;
    this.orchestrator = orchestrator;
    this.changed = changed;
    this.host = new AgentHost(store, ROLE_RECORDS.conversation, host);
  }

  list() {
    return this.store.sessionIds()
      .map((id) => { try { return this.store.readSession(id); } catch { return undefined; } })
      .filter((s): s is SessionFile => s?.role === "conversation")
      .map((s) => {
        const chat = this.store.readChat(s.id).entries;
        return { ...s, state: this.host.get(s.id)?.proc.state ?? "exited", last_at: chat.at(-1)?.at ?? s.created_at, messages: chat.filter((c) => c.kind === "message").length };
      })
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.last_at.localeCompare(a.last_at));
  }

  view(id: string) {
    const s = this.session(id);
    return { session: s, state: this.host.get(id)?.proc.state ?? "exited", runtime: this.store.readRuntime(id) ?? null, ...chatView(this.store, id, 400), model: s.model ?? null, effort: s.effort ?? null, notes_dir: this.store.readProject().conversations.notes_dir ?? null };
  }

  /**
   * `queue` and `step` (both or neither) link the conversation to a step ("Chat about this"). Creating it starts no
   * model turn and changes nothing in the run; the step's context goes to the partner with the user's first message.
   */
  create(body: { title?: unknown; runtime?: unknown; model?: unknown; effort?: unknown; queue?: unknown; step?: unknown }): SessionFile {
    const p = this.store.readProject();
    const c = p.conversations;
    const about = this.stepLink(body.queue, body.step);
    const runtime = body.runtime === "codex" || body.runtime === "claude" ? body.runtime : c.runtime;
    // A model or effort the start names is the conversation's own; without one it follows the project's (effective)
    // conversation settings, also when they change later (from its next message on).
    const effort = parseEffort(body.effort);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const issue = effortIssue(runtime, effort ?? (runtime === c.runtime ? c.effort : undefined));
    if (issue) throw new ActionError(issue);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120)
      : about ? `${about.step}: ${about.title}`.slice(0, 120) : "New conversation";
    const s: SessionFile = {
      protocol: 1, id: newId(), project: p.id, role: "conversation", runtime, title,
      native_id: runtime === "claude" ? randomUUID() : null, cwd: normPath(p.root), launched_by: "nexus", created_at: now(),
      model, effort,
      ...(about ? { about: { queue: about.queue, step: about.step } } : {}),
    };
    this.store.writeSession(s);
    this.changed();
    return s;
  }

  /** The step's latest conversation that is not archived (by its last message), if it has one. */
  latestFor(queue: string, step: string): SessionFile | undefined {
    return this.list().filter((s) => !s.archived && s.about?.queue === queue && s.about.step === step)
      .sort((a, b) => b.last_at.localeCompare(a.last_at) || b.created_at.localeCompare(a.created_at))[0];
  }

  private stepLink(queue: unknown, step: unknown): { queue: string; step: string; title: string } | undefined {
    if (queue === undefined && step === undefined) return undefined;
    if (typeof queue !== "string" || typeof step !== "string" || !queue || !step) throw new ActionError("a conversation about a step needs both queue and step");
    const found = findStep(loadProjectState(this.store), queue, step);
    if (!found) throw new ActionError(`queue ${queue} has no step ${step}`, 404);
    return { queue, step, title: found.st.title };
  }

  update(id: string, body: { title?: unknown; model?: unknown; effort?: unknown; archived?: unknown }): void {
    const s = this.session(id);
    const next = { ...s };
    if (typeof body.title === "string" && body.title.trim()) next.title = body.title.trim().slice(0, 120);
    if (body.model !== undefined) next.model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    if (body.effort !== undefined) next.effort = parseEffort(body.effort);
    if (typeof body.archived === "boolean") next.archived = body.archived;
    const issue = next.runtime === "external" ? undefined : effortIssue(next.runtime, next.effort);
    if (issue) throw new ActionError(issue);
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
    this.deliver(s, this.withStepContext(s, text.trim()));
  }

  /**
   * A conversation about a step: its first message carries the step's context (the seed), and a later one a short
   * "since then" addition when the step changed state since. The chat keeps the user's words only.
   */
  private withStepContext(s: SessionFile, text: string): string {
    if (!s.about) return text;
    const state = loadProjectState(this.store);
    const { queue, step, seeded } = s.about;
    const context = seeded ? sinceThen(state, queue, step, seeded) : stepSeed(state, queue, step);
    if (!context) return text;
    const status = findStep(state, queue, step)?.st.status;
    this.store.writeSession({ ...this.store.readSession(s.id), about: { queue, step, seeded: status ? { status, at: now() } : seeded } });
    return `${context}

${text}`;
  }

  /** The user's stop button: interrupts the partner's running turn, as the orchestrator's stop does (Orchestrator.stop). */
  stop(id: string): void {
    const s = this.session(id);
    const l = this.host.running(s.id);
    if (!l || !l.proc.stop()) throw new ActionError("the partner is not working", 409);
    this.store.appendChat(id, { at: now(), from: "nexus", text: STOPPED });
    this.changed();
  }

  /** The partner summarizes the conversation; the summary then goes to the orchestrator's chat. */
  handoff(id: string): void {
    if (this.draining) throw new ActionError("Nexus is updating; try after the restart", 409);
    const s = this.session(id);
    this.store.appendChat(id, { at: now(), from: "nexus", text: "Summarizing this conversation for the orchestrator…" });
    const l = this.ensure(s);
    l.handoff = true;
    this.deliver(s, `[Nexus] The user hands this conversation to the orchestrator, who plans and runs work in queues. Write a summary for it, in ${languageName(this.store.readProject().languages.working)}: what was decided (only what the user decided), the open questions, the work you propose (as steps with what each should achieve), and the files where the notes are. ${HANDOFF_SCOPE} Reply with the summary only.`);
  }

  idle(): boolean { return this.host.idle(); }

  shutdown(): void { for (const l of this.host.all()) clearTimeout(l.timer); this.host.shutdown(); }

  /** A partner's process is still running (after shutdown: not yet exited). */
  alive(): boolean { return this.host.alive(); }

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
    clearTimeout(this.host.get(id)?.timer);
    this.host.retire(id);
  }

  /**
   * The model and effort the conversation runs on: its own, else the project's (effective) conversation settings when
   * it runs on their runtime. An effort its runtime does not take is refused with the reason.
   */
  private values(s: SessionFile): { model?: string; effort?: Effort } {
    const c = this.store.readProject().conversations;
    const same = s.runtime === c.runtime;
    const v = { model: s.model ?? (same ? c.model : undefined), effort: s.effort ?? (same ? c.effort : undefined) };
    const issue = s.runtime === "external" ? undefined : effortIssue(s.runtime, v.effort);
    if (issue) throw new ActionError(`this conversation would run at effort ${v.effort}: ${issue}`, 409);
    return v;
  }

  /** How the conversation's process is started, from the session and the project's effective settings now. */
  private launcher(s: SessionFile): (resume: boolean) => Launch {
    const p = this.store.readProject();
    const notes = p.conversations.notes_dir;
    const env = this.host.env(s.id);
    const instructions = partnerBriefing(p, notes);
    const { model, effort } = this.values(s);
    return (resume) => {
      if (s.runtime === "codex") {
        // Its working directory is the notes folder: the sandbox writes only there. Without one it is read-only.
        const cwd = notes ? join(p.root, notes) : p.root;
        if (notes) mkdirSync(cwd, { recursive: true });
        return { runtime: "codex", options: {
          cwd, model, effort, instructions, env, threadId: s.native_id,
          sandbox: notes ? "workspace-write" : "read-only", approvalPolicy: "never", writableRoots: [],
        } };
      }
      return { runtime: "claude", options: {
        cwd: p.root, uuid: s.native_id!, resume,
        model, effort, permissionMode: "dontAsk",
        allowedTools: notes ? [...READ, `Edit(${notes}/**)`] : READ,
        disallowedTools: ["NotebookEdit"],
        appendSystemPrompt: instructions, env,
      } };
    };
  }

  private ensure(s: SessionFile): Live {
    const existing = this.host.running(s.id);
    // Settings it was started with changed since (the conversation settings it follows, the notes folder): a new
    // process from this message on (a working one ends after its turn), resuming the conversation.
    if (existing && !this.host.stale(s.id, this.launcher(s))) return existing;
    if (existing) {
      if (existing.proc.state === "working") { this.host.restartAfterTurn(s.id); return existing; }
      this.retire(s.id);
    }
    return this.host.start(s, this.launcher(s), {}, (l) => {
      // The partner's last text of the turn, whole: during a hand-over, the summary.
      let reply = "";
      return {
        message: (text) => { reply = text; if (!l.handoff) this.store.appendChat(s.id, { at: now(), from: "partner", text }); },
        activity: (a) => {
          if (a.kind === "tool") this.store.appendChat(s.id, { at: now(), from: "partner", kind: "tool", text: a.text });
          else if (a.kind === "error") this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: a.text });
          else if (a.kind === "turn_start") reply = "";
        },
        turnEnd: (end) => {
          if (l.handoff) {
            l.handoff = false;
            // A stopped hand-over hands nothing over.
            const summary = end.text === "stopped" ? "" : reply.trim();
            if (summary) {
              this.store.appendChat(s.id, { at: now(), from: "partner", text: summary });
              try {
                this.orchestrator.say(`[From the conversation "${this.session(s.id).title}"]\n\n${summary}`);
                this.store.appendChat(s.id, { at: now(), from: "nexus", text: "The summary went to the orchestrator's chat." });
              } catch (e) { this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: `Could not hand it over: ${(e as Error).message}` }); }
            }
          }
          clearTimeout(l.timer);
          l.timer = setTimeout(() => { if (l.proc.state !== "working" && this.host.get(s.id) === l) { this.host.retire(s.id); this.changed(); } }, IDLE_MS);
          this.changed();
        },
        exit: () => this.changed(),
      };
    });
  }
}

function parseEffort(v: unknown): Effort | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const r = Effort.safeParse(v);
  if (!r.success) throw new ActionError(`effort is one of ${Effort.options.join(", ")}`);
  return r.data;
}


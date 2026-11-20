// Conversations: thinking partners the user talks with about a project (gameplay design, ideas), one session per
// thread. They read the whole project and write only in its notes folder; they start no work. A conversation can
// be handed to the orchestrator: the partner writes a summary, which goes into the orchestrator's chat.
//
// The web: by `conversations.web` (claudeWeb, CODEX_WEB_SEARCH; docs/protocol/conversations.md, "Conversations"). A Codex partner runs
// without the user's own Codex tools (MCP servers, plugins, apps), which run outside its sandbox.
//
// Writing only in the notes folder: Claude Code runs in `dontAsk` mode with `Edit(<notes>/**)` as the only write
// rule (checked: writes elsewhere and shell writes are refused). Codex runs with the notes folder as its working
// directory in a `workspace-write` sandbox, which reads everywhere and writes only there; it is never asked.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ActionError, Effort, ProjectStore, type ConversationWeb, effortIssue, ideaContext, ideaHash, languageName, loadProjectState, newId, normPath, now, type SessionFile,
} from "@nexus/protocol";
import { findStep, sinceThen, stepSeed } from "./step-seed.ts";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Hosted, type Launch } from "./agent-host.ts";
import { COMPACTS } from "./agent.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { partnerBriefing, restartedNotice } from "./prompts.ts";
import { RESTARTED, STOPPED, chatView } from "./chats.ts";
import { guardSettings, webFetchDenyRules } from "./web-guard.ts";
import { shellRules } from "./shell-rules.ts";

// `nexus help` (decided 2026-11-15, queue OP): how Nexus works, its topics; it reads only. A Codex partner runs it in
// its sandbox, which reads everywhere.
const READ = ["Read", "Grep", "Glob", ...shellRules(["nexus status", "nexus ideas status", "nexus help", "nexus doc", "nexus tags", "git log", "git status", "git diff", "git show"])];
/** With a notes folder the partner also records what its hand-over covers (`nexus covers`, among its own events). */
const COVERS = shellRules(["nexus covers"]);
/** What a hand-over covers (decided 2026-11-14): this conversation's topics, and the dates of the decisions it passes on. */
const HANDOFF_SCOPE = "Summarize only the topics discussed in this conversation, unless the user asked you to include others. From a notes file, pass on what this conversation decided or recorded; another topic in the notes folder, even a related one, is not part of this hand-over: name its file at most, as 'see also', without its content. Run nexus ideas status for the current effective state (a summary per entry; one entry's full JSON: nexus ideas status <file>.md#<date>), and read an entry with nexus doc <file>.md#<date>. In notes, Decided holds the decision content; read it together with the effective user dispositions and assessment invalidations in .nexus/idea-statuses.yaml and the relationships in .nexus/idea-matches.yaml. Report conflicts; Open/Ideas remain undecided. Historical hand-over does not override a later drop, replacement or reopening, and does not approve or start a queue. Name the dates of the Decided entries you cover.";
/** The hand-over's record for the ideas overview (decided 2026-11-15, queue IO): the entries it covers, by command. */
const HANDOFF_COVERS = "Before you reply, record the Decided entries this hand-over passes on: nexus covers <file>.md#<YYYY-MM-DD> ... (one argument per entry, the notes folder may be left out); if it refuses one, fix the reference and run it again. The ideas overview shows them as handed over.";
/**
 * What a Claude partner may do on the web, by the `conversations.web` level: its allow and deny rules, and for `fetch`
 * the guard hook that refuses any host resolving to a local or internal address (web-guard.ts). WebSearch runs at
 * Anthropic and reaches no local address; WebFetch runs on this machine.
 */
function claudeWeb(web: ConversationWeb): { allowed: string[]; denied: string[]; settings?: string } {
  if (web === "off") return { allowed: [], denied: ["WebSearch", "WebFetch"] };
  if (web === "search") return { allowed: ["WebSearch"], denied: ["WebFetch"] };
  return { allowed: ["WebSearch", "WebFetch"], denied: webFetchDenyRules(), settings: guardSettings() };
}

/**
 * Codex's web search mode by level: `cached` searches OpenAI's index, `live` also opens pages (probed with Codex
 * 0.167.2: an openPage action). Both run at OpenAI: no local address is reached. `disabled` turns it off; the user's
 * tools (the apps' search connector among them) are off for a partner anyway (CodexOptions.withoutUserTools).
 */
export const CODEX_WEB_SEARCH: Record<ConversationWeb, string> = { off: "disabled", search: "cached", fetch: "live" };

/** The chat's line once a conversation is compacted (with the tokens before and after, where the runtime says). */
export const COMPACTED = "The conversation's context was compacted";

const IDLE_MS = 15 * 60_000; // an idle partner's process ends; the next message resumes the conversation

/** What a partner's process keeps beside it: its idle timer, and whether its running turn writes a hand-over. */
/**
 * `handoff`: the running turn is the hand-over's, its reply the summary. `handoffNext`: the hand-over was asked while
 * another turn ran; its instruction waits as the next turn, and that turn is the hand-over's.
 */
/**
 * `compacting`: the running turn is a compaction the user asked for (compact); `compacted`: the runtime said it is done.
 */
type Extra = { timer?: NodeJS.Timeout; handoff?: boolean; handoffNext?: boolean; compacting?: boolean; compacted?: boolean };
type Live = Hosted<Extra>;

export class Conversations {
  private readonly store: ProjectStore;
  /** Where the list and the views read (the server's model of the files, main.ts); what decides reads `store`. */
  private readonly reads: ProjectStore;
  private readonly orchestrator: Orchestrator;
  private readonly changed: () => void;
  private readonly host: AgentHost<Extra>;
  private readonly compacts: (runtime: "claude" | "codex") => boolean;
  /** Set by shutdown: no idle timer is armed after it. */
  private stopped = false;

  /** `host`: how the partners' processes are made (tests give a stand-in). */
  constructor(store: ProjectStore, orchestrator: Orchestrator, changed: () => void, host: AgentHostOptions & { reads?: ProjectStore } = {}) {
    this.store = store;
    this.reads = host.reads ?? store;
    this.orchestrator = orchestrator;
    this.changed = changed;
    this.host = new AgentHost(store, ROLE_RECORDS.conversation, host);
    this.compacts = host.compacts ?? ((r) => COMPACTS[r]);
  }

  list() {
    return this.reads.sessionIds()
      .map((id) => { try { return this.reads.readSession(id); } catch { return undefined; } })
      .filter((s): s is SessionFile => s?.role === "conversation")
      .map((s) => {
        const chat = this.reads.readChat(s.id).entries;
        return { ...s, state: this.host.get(s.id)?.proc.state ?? "exited", last_at: chat.at(-1)?.at ?? s.created_at, messages: chat.filter((c) => c.kind === "message").length };
      })
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.last_at.localeCompare(a.last_at));
  }

  view(id: string) {
    const s = this.session(id);
    return {
      session: s, state: this.host.get(id)?.proc.state ?? "exited", runtime: this.reads.readRuntime(id) ?? null, ...chatView(this.reads, id, 400),
      model: s.model ?? null, effort: s.effort ?? null, notes_dir: this.reads.readProject().conversations.notes_dir ?? null,
      // Whether its runtime compacts on request: the dashboard offers Compact only then.
      compact: this.canCompact(s),
      idea_context_error: this.ideaContextError(s),
    };
  }

  private canCompact(s: SessionFile): boolean { return s.runtime !== "external" && this.compacts(s.runtime); }

  /**
   * The user's Compact (decided 2026-11-15, queue CC3): the runtime compacts the conversation's context, in a turn of
   * its own, and the chat gets a Nexus line once it is done. The conversation goes on in the same session. Refused
   * while the partner is at a turn, and for a runtime that cannot.
   */
  compact(id: string): void {
    const s = this.session(id);
    const cannot = () => new ActionError(`a ${s.runtime} conversation cannot be compacted`, 409);
    const answering = () => new ActionError("the partner is answering: compact once its turn is over", 409);
    if (!this.canCompact(s)) throw cannot();
    if (!this.store.readChat(id).entries.some((c) => c.from === "partner" && c.kind === "message")) throw new ActionError("the conversation has nothing to compact yet", 409);
    if (this.host.running(id)?.proc.state === "working") throw answering();
    const l = this.ensure(s);
    if (!l.proc.compact) throw cannot();
    clearTimeout(l.timer);
    l.compacting = true;
    l.compacted = false;
    if (!l.proc.compact()) { l.compacting = false; throw answering(); }
    this.changed();
  }

  /**
   * `queue` and `step` (both or neither) link the conversation to a step ("Chat about this"). Creating it starts no
   * model turn and changes nothing in the run; the step's context goes to the partner with the user's first message.
   */
  create(body: { title?: unknown; runtime?: unknown; model?: unknown; effort?: unknown; queue?: unknown; step?: unknown; idea?: unknown; request_id?: unknown }): SessionFile {
    const p = this.store.readProject();
    const c = p.conversations;
    const request = body.idea !== undefined ? this.creationRequest(body) : undefined;
    const previous = request && this.list().find((s) => s.creation_request?.id === request.id);
    if (previous) {
      if (previous.creation_request!.fingerprint !== request!.fingerprint) throw new ActionError("request_id already names another conversation", 409);
      return this.session(previous.id);
    }
    if (body.idea !== undefined && (body.queue !== undefined || body.step !== undefined)) throw new ActionError("Choose either an idea or a step scope");
    const idea = body.idea !== undefined ? ideaContext(this.store, body.idea) : undefined;
    const about = this.stepLink(body.queue, body.step);
    const runtime = body.runtime === "codex" || body.runtime === "claude" ? body.runtime : c.runtime;
    // A model or effort the start names is the conversation's own; without one it follows the project's (effective)
    // conversation settings, also when they change later (from its next message on).
    const effort = parseEffort(body.effort);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const issue = effortIssue(runtime, effort ?? (runtime === c.runtime ? c.effort : undefined));
    if (issue) throw new ActionError(issue);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120)
      : idea ? `${idea.snapshot.title}${idea.scope.date ? ` / ${idea.scope.date}` : ""}`
        : about ? `${about.step}: ${about.title}`.slice(0, 120) : "New conversation";
    const s: SessionFile = {
      protocol: 1, id: newId(), project: p.id, role: "conversation", runtime, title,
      native_id: runtime === "claude" ? randomUUID() : null, cwd: normPath(p.root), launched_by: "nexus", created_at: now(),
      model, effort,
      ...(about ? { about: { queue: about.queue, step: about.step } } : {}),
      ...(idea ? { about: { idea: idea.scope }, creation_request: request } : {}),
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
    const s = this.session(id);
    if (s.about?.idea && s.archived) throw new ActionError("This idea conversation is archived; restore it before sending a message", 409);
    // Validate missing context before recording a user message or launching a process.
    const idea = this.ideaMessage(s, text.trim());
    const context = idea?.text ?? this.withStepContext(s, text.trim());
    this.store.appendChat(id, { at: now(), from: "user", text: text.trim() });
    this.deliver(s, context, [text.trim()]);
    if (idea) this.store.writeSession({ ...this.store.readSession(s.id), about: { idea: idea.scope } });
  }

  private creationRequest(body: Record<string, unknown>) {
    if (typeof body.request_id !== "string" || !body.request_id.trim() || body.request_id.length > 200) throw new ActionError("Idea conversation creation requires a stable request_id");
    return { id: body.request_id, fingerprint: ideaHash(body) };
  }

  private ideaContextError(s: SessionFile): string | undefined {
    if (!s.about?.idea) return undefined;
    try { ideaContext(this.store, { file: s.about.idea.file, ...(s.about.idea.date ? { date: s.about.idea.date } : {}) }); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
    return undefined;
  }

  private ideaMessage(s: SessionFile, text: string) {
    if (!s.about?.idea) return undefined;
    const { file, date, seeded } = s.about.idea;
    const context = ideaContext(this.store, { file, ...(date ? { date } : {}) });
    return { scope: { file, date, seeded: context.revision }, text: context.revision === seeded ? text
      : `${seeded ? "[Nexus] The scoped idea context changed; use this current snapshot.\n\n" : ""}${context.text}\n\nUser message\n${text}` };
  }

  /**
   * A conversation about a step: its first message carries the step's context (the seed), and a later one a short
   * "since then" addition when the step changed state since. The chat keeps the user's words only.
   */
  private withStepContext(s: SessionFile, text: string): string {
    if (!s.about || s.about.idea) return text;
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
    const s = this.session(id);
    if (s.about?.idea) throw new ActionError("Use the idea handoff preview to choose exact dates; an idea chat is not handed over as a conversation-wide summary", 409);
    this.store.appendChat(id, { at: now(), from: "nexus", text: "Summarizing this conversation for the orchestrator…" });
    const l = this.ensure(s);
    // While the partner is still at a turn (its reply on the way), the instruction waits for that turn's end and runs
    // as a turn of its own: put into the running turn, that turn's reply (not a summary) went over as the summary
    // (queue FU4). Idle, it starts the turn at once.
    clearTimeout(l.timer);
    if (l.proc.state === "working") l.handoffNext = true; else l.handoff = true;
    const p = this.store.readProject();
    const covers = p.conversations.notes_dir ? ` ${HANDOFF_COVERS}` : "";
    this.host.send(l, `[Nexus] The user hands this conversation to the orchestrator, who plans and runs work in queues. Write a summary for it, in ${languageName(p.languages.working)}: what was decided (only what the user decided), the open questions, the work you propose (as steps with what each should achieve), and the files where the notes are. ${HANDOFF_SCOPE}${covers} Reply with the summary only.`, { afterTurn: true });
    this.changed();
  }

  idle(): boolean { return this.host.idle(); }

  /**
   * Before the hand-over to the next server (an update): the partners' turns still running are cut off, and each
   * session's record keeps what its turn answered, and whether it was the hand-over's (AgentHost.cutOff). The next
   * server goes on with them (resumeCutOff).
   */
  cutOff(): void { this.host.cutOff((l) => (l.handoff || l.handoffNext ? { handoff: true } : {})); }

  /**
   * After a restart that cut off partners' turns (cutOff): each conversation goes on in its session, told what it was
   * answering (a hand-over's turn is the hand-over's again); its chat says so in a line of its own.
   */
  resumeCutOff(): void {
    for (const s of this.list()) {
      const cut = this.host.interruption(s.id);
      if (!cut) continue;
      try {
        this.store.appendChat(s.id, { at: now(), from: "nexus", text: RESTARTED });
        const l = this.ensure(s);
        clearTimeout(l.timer);
        if (cut.handoff) l.handoff = true;
        const idea = this.ideaMessage(s, restartedNotice(cut.asked));
        this.host.send(l, idea?.text ?? restartedNotice(cut.asked), { quote: cut.asked });
        if (idea) this.store.writeSession({ ...this.store.readSession(s.id), about: { idea: idea.scope } });
      } catch (e) {
        this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: `Could not go on after the restart: ${(e as Error).message}` });
      }
      this.host.resumed(s.id);
    }
    this.changed();
  }

  shutdown(): void { this.stopped = true; for (const l of this.host.all()) clearTimeout(l.timer); this.host.shutdown(); }

  /** A partner's process is still running (after shutdown: not yet exited). */
  alive(): boolean { return this.host.alive(); }

  // ---------------------------------------------------------------- processes

  private session(id: string): SessionFile {
    let s: SessionFile;
    try { s = this.store.readSession(id); } catch { throw new ActionError("no such conversation", 404); }
    if (s.role !== "conversation") throw new ActionError("no such conversation", 404);
    return s;
  }

  /** `quote`: what the turn answers, should a restart cut it off (the user's words, without the step's context). */
  private deliver(s: SessionFile, text: string, quote: readonly string[]): void {
    const l = this.ensure(s);
    clearTimeout(l.timer);
    this.host.send(l, text, { quote });
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
    const web = p.conversations.web;
    const instructions = partnerBriefing(p, notes, s.runtime === "codex" ? "codex" : "claude");
    const { model, effort } = this.values(s);
    return (resume) => {
      if (s.runtime === "codex") {
        // Its working directory is the notes folder: the sandbox writes only there. Without one it is read-only.
        const cwd = notes ? join(p.root, notes) : p.root;
        if (notes) mkdirSync(cwd, { recursive: true });
        return { runtime: "codex", options: {
          cwd, model, effort, instructions, env, threadId: s.native_id,
          // Its own session folder too: `nexus covers` appends to its events there.
          sandbox: notes ? "workspace-write" : "read-only", approvalPolicy: "never", writableRoots: notes ? [this.store.sessionDir(s.id)] : [],
          config: { web_search: CODEX_WEB_SEARCH[web] }, withoutUserTools: true,
        } };
      }
      const w = claudeWeb(web);
      return { runtime: "claude", options: {
        cwd: p.root, uuid: s.native_id!, resume,
        model, effort, permissionMode: "dontAsk",
        allowedTools: [...READ, ...(notes ? [`Edit(${notes}/**)`, ...COVERS] : []), ...w.allowed],
        disallowedTools: ["NotebookEdit", ...w.denied],
        ...(w.settings ? { settings: w.settings } : {}),
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
      // Settling (AgentProcess.settling): a message sent into its last turn may still run as a turn of its own, which
      // ending it now would lose. This message goes to it too; the next one, once it is over, finds it stale.
      if (existing.proc.settling) return existing;
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
        compacted: (c) => {
          if (!l.compacting) return; // the runtime's own compaction in a turn: not the user's
          l.compacted = true;
          const tokens = c.before && c.after ? `: ${c.before.toLocaleString("en-US")} tokens of context became ${c.after.toLocaleString("en-US")}` : ".";
          this.store.appendChat(s.id, { at: now(), from: "nexus", text: `${COMPACTED}${tokens}` });
        },
        turnEnd: (end) => {
          if (l.compacting) {
            l.compacting = false;
            if (!l.compacted) this.store.appendChat(s.id, { at: now(), from: "nexus", kind: "error", text: `The conversation was not compacted${end.text === "stopped" ? ": stopped" : end.ok ? "" : `: ${end.text}`}.` });
          } else if (l.handoff) {
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
          // A hand-over asked during the turn that just ended: the next turn, its instruction, is the hand-over's.
          else if (l.handoffNext) { l.handoffNext = false; l.handoff = true; }
          clearTimeout(l.timer);
          // Not after shutdown: a turn's end the stopped process still delivers would arm it again, and an armed timer
          // kept a stopped Nexus (a test's process) alive for its 15 minutes (queue FU4). It never keeps Node up.
          if (!this.stopped) {
            l.timer = setTimeout(() => { if (l.proc.state !== "working" && this.host.get(s.id) === l) { this.host.retire(s.id); this.changed(); } }, IDLE_MS);
            l.timer.unref();
          }
          this.changed();
        },
        exit: () => { clearTimeout(l.timer); this.changed(); },
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


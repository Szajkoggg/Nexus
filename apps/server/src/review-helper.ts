// The review helper (queue RH; docs/design/review.md, "Routine reviews by a helper"; docs/protocol/review.md, "The review helper"): a
// short-lived session that takes the orchestrator's routine review of one step, for one review round, on a model and
// effort of its own (`review_helper`). It gets a fixed packet as its only message (packet.md, with the step's diff in
// diff.patch beside it), reads, and decides with `nexus review accept|send-back|pass-on`; then its process ends. What
// it passes on (or what Nexus passes on without it) reaches the orchestrator as its review notice, with the reasons and
// the helper's findings; what it accepts never reaches the orchestrator's chat.
//
// The orchestrator runs this before its own notices (Orchestrator.changedState), so a step a helper takes is never also
// told to the orchestrator. Review levels, away mode and provisional acceptances keep their rules: the helper goes by
// the step's own level (H6), accepts only at level 2 (H5), and has no command for a provisional acceptance.
//
// Its rights (H15): Claude Code in `dontAsk` mode with reading tools, read-only git, `nexus status`, `nexus help` and
// the three review commands, which the CLI takes from a helper only for its step and round; Codex with its session folder
// as the working directory and only writable root (for the CLI's events). A refused action is recorded in its
// refusals.jsonl, and its briefing asks it to pass on with `doubt`: nothing is ever asked.
import { errorText } from "@nexus/protocol/errors";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HELPER_VERDICTS, NEXUS_SESSION, acceptedByNexus, effortIssue, ensureNexusSession, helperAbout, loadProjectState, newId, normPath, now, overThreshold, readUsage, reviewRound,
  reviewedByOrchestrator, sendBack, type PassOnReason, type ProjectState, type ProjectStore, type QueueView, type SessionFile, type StepView,
} from "@nexus/protocol";
import { AgentHost, ROLE_RECORDS, type AgentHostOptions, type Hosted, type Launch } from "./agent-host.ts";
import { checkoutOf } from "./gitinfo.ts";
import { helperBriefing, helperPacket } from "./prompts.ts";
import { shellRules } from "./shell-rules.ts";
import { gitLabel, perf } from "./perf.ts";

/**
 * Whether the orchestrator audits a review helper's acceptance (H11): the first 8 hexadecimal digits of the SHA-256 of
 * the acceptance's event id, read as a fraction of 2^32, are below `rate` (review_helper.audit_rate). It needs no
 * state, survives a restart, and a test steers it by the id (or the rate: 0 none, 1 all).
 */
export function audited(event: string, rate: number): boolean {
  return Number.parseInt(createHash("sha256").update(event).digest("hex").slice(0, 8), 16) / 2 ** 32 < rate;
}

/** How long a helper may take before Nexus ends it and passes the step on (`no_verdict`, H8). */
const HELPER_LIMIT_MS = 20 * 60_000;

/** What a helper may run besides reading (H15); each on every shell tool. */
const HELPER_TOOLS = ["Read", "Grep", "Glob", ...shellRules([
  "git log", "git status", "git diff", "git show", "nexus status", "nexus help", "nexus doc",
  "nexus review accept", "nexus review send-back", "nexus review pass-on",
])];
/** Never a helper's, whatever a project allows its workers. */
const HELPER_DENIED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

export interface HelperOptions extends AgentHostOptions {
  /** The time limit (HELPER_LIMIT_MS); tests give a short one. */
  limitMs?: number;
}

/** What a helper's process keeps beside it: its time limit, and why its turn failed or it was ended. */
type Extra = { timer?: NodeJS.Timeout; failure?: string; timedOut?: boolean };

export class ReviewHelpers {
  private readonly store: ProjectStore;
  private readonly changed: () => void;
  private readonly draining: () => boolean;
  private readonly host: AgentHost<Extra>;
  private readonly limitMs: number;
  private stopped = false;

  constructor(store: ProjectStore, changed: () => void, draining: () => boolean, options: HelperOptions = {}) {
    this.store = store;
    this.changed = changed;
    this.draining = draining;
    this.host = new AgentHost(store, ROLE_RECORDS.helper, options);
    this.limitMs = options.limitMs ?? HELPER_LIMIT_MS;
  }

  /**
   * After every change, before the orchestrator's notices: carries out the helpers' send-backs, ends a helper whose step
   * left the orchestrator's review, and gives each step newly waiting for it a helper, or passes it on at once (H3,
   * H8). True when it wrote anything (the caller reads the state again).
   */
  onChange(state: ProjectState): boolean {
    if (this.stopped) return false;
    let wrote = this.applySendBacks(state);
    if (wrote) state = loadProjectState(this.store);
    this.endLeft(state);
    if (!this.takes(state)) return wrote;
    for (const q of state.queues) for (const st of q.steps) {
      // Only where the orchestrator would review (H2); not the integration step Nexus accepts itself (queue MI).
      if (!reviewedByOrchestrator(st) || acceptedByNexus(q, st) || st.helper?.state === "passed_on") continue;
      if (this.take(state, q, st)) wrote = true;
    }
    return wrote;
  }

  /** Whether helpers take the reviews now: on in the settings, and Nexus neither stopping nor updating. */
  takes(state: ProjectState): boolean { return !this.stopped && state.project.review_helper.enabled && !this.draining(); }

  /** A helper's process is still running. */
  alive(): boolean { return this.host.alive(); }

  /** Ends every helper (the server stops); a helper running now is started again once by the next server (H8). */
  shutdown(): void {
    this.stopped = true;
    for (const l of this.host.all()) clearTimeout(l.timer);
    this.host.shutdown();
  }

  /** The helpers' send-backs, carried out once each as the orchestrator's are (the CLI waits for the result). */
  private applySendBacks(state: ProjectState): boolean {
    let wrote = false;
    for (const s of state.sessions) {
      if (s.role !== "helper") continue;
      const done = new Set(this.store.readApplied(s.id).entries.map((a) => a.event));
      for (const e of this.store.readEvents(s.id).entries) {
        if (e.type !== "review.sent_back" || done.has(e.id)) continue;
        let ok = true; let message: string;
        try { message = sendBack(this.store, { queue: e.queue, step: e.step, from: "helper", text: e.text, event: e.id }); }
        catch (err) { ok = false; message = errorText(err); }
        this.store.appendApplied(s.id, { at: now(), event: e.id, ok, message });
        wrote = true;
      }
    }
    return wrote;
  }

  /** A helper whose step no longer waits for it (the user took the review, a verdict counted): its process ends. */
  private endLeft(state: ProjectState): void {
    for (const l of this.host.all()) {
      const a = helperAbout(state.sessions.find((x) => x.id === l.session) ?? { role: "helper" });
      const st = a && state.queues.find((q) => q.id === a.queue)?.steps.find((x) => x.id === a.step);
      if (st && reviewedByOrchestrator(st) && st.helper?.state === "running" && st.helper.session === l.session) continue;
      clearTimeout(l.timer);
      this.host.retire(l.session);
    }
  }

  /**
   * The step's review round, if no helper has it yet: passed on at once when Nexus can tell without a model, else a
   * helper starts. A helper of this round without a process (a restart cut it off) is started again once; a second one
   * without a verdict passes on (H8). True when it wrote anything.
   */
  private take(state: ProjectState, q: QueueView, st: StepView): boolean {
    const round = reviewRound(q, st);
    const mine = state.sessions.filter((s) => { const a = helperAbout(s); return a?.queue === q.id && a.step === st.id && a.round === round; });
    if (mine.some((s) => this.host.running(s.id))) return false;
    // A verdict given and not carried out yet (a send-back on its way to the worker): nothing to start.
    if (mine.some((s) => this.store.readEvents(s.id).entries.some((e) => HELPER_VERDICTS.has(e.type)))) return false;
    if (mine.length >= 2) return this.passOn(q, st, round, ["no_verdict"], "The review helper was started twice for this round (once again after a restart) and gave no verdict.");
    if (!mine.length) {
      const reason = this.atOnce(state, q, st);
      if (reason) return this.passOn(q, st, round, [reason.why], reason.text);
    }
    const s = state.project.review_helper;
    const runtime = s.runtime;
    const model = s.model ?? state.project.runtimes[runtime].model ?? undefined;
    const effort = s.effort ?? state.project.runtimes[runtime].effort ?? undefined;
    const full = overThreshold(runtime, readUsage()?.windows ?? {}, state.project.defaults.usage_pause_threshold, Date.now());
    if (full) return this.passOn(q, st, round, ["unavailable"], `The review helper's runtime is beyond the usage threshold: ${full.reason}.`);
    const issue = effortIssue(runtime, effort);
    if (issue) return this.passOn(q, st, round, ["unavailable"], `The review helper's settings cannot run: effort ${effort}: ${issue}.`);
    try { this.start(state, q, st, round, { runtime, model, effort }); }
    catch (e) { return this.passOn(q, st, round, ["unavailable"], `The review helper could not start: ${errorText(e)}`); }
    return true;
  }

  /**
   * What the engine can tell without a model (H3): a question the worker asked in this round, or the send-back limit
   * reached (the next send-back would go to the user).
   */
  private atOnce(state: ProjectState, q: QueueView, st: StepView): { why: PassOnReason; text: string } | undefined {
    const since = st.sent_back.filter((b) => b.delivered).at(-1)?.at ?? "";
    const asked = state.questions.filter((x) => x.queue === q.id && x.step === st.id && x.asked_at >= since
      && state.sessions.find((s) => s.id === x.session)?.role === "worker");
    if (asked.length) return { why: "question", text: `The worker asked during this round: ${asked.map((x) => `"${x.text}" (${x.qid})`).join("; ")}.` };
    const limit = state.project.defaults.review_send_back_limit;
    const count = st.sent_back.filter((b) => b.by !== "user" && !b.to_user).length;
    if (count >= limit) return { why: "limit", text: `The step was sent back ${count} time${count === 1 ? "" : "s"}; the limit is ${limit}.` };
    return undefined;
  }

  /** Nexus passes the step on to the orchestrator (a review.passed_on of its own session). */
  private passOn(q: QueueView, st: StepView, round: number, reasons: PassOnReason[], text: string): boolean {
    ensureNexusSession(this.store);
    this.store.appendEvent({ v: 1, id: newId(), at: now(), session: NEXUS_SESSION, type: "review.passed_on", queue: q.id, step: st.id, round, reasons, text });
    return true;
  }

  /** Starts a helper for the step's round: its session, its packet and diff, its process with the packet as its turn. */
  private start(state: ProjectState, q: QueueView, st: StepView, round: number, on: { runtime: "claude" | "codex"; model?: string; effort?: SessionFile["effort"] }): void {
    const checkout = checkoutOf(this.store, q) ?? normPath(state.project.root);
    const id = newId();
    const dir = this.store.sessionDir(id);
    const session: SessionFile = {
      protocol: 1, id, project: state.project.id, role: "helper", runtime: on.runtime,
      native_id: on.runtime === "claude" ? randomUUID() : null, cwd: on.runtime === "codex" ? normPath(dir) : checkout,
      launched_by: "nexus", created_at: now(), model: on.model, effort: on.effort,
      title: `Review of ${q.id}/${st.id}, round ${round}`,
      about: { queue: q.id, step: st.id, round, level: st.level },
    };
    this.store.writeSession(session);
    const diff = join(dir, "diff.patch");
    const range = this.diff(q, st, checkout, diff);
    const packet = helperPacket(q, st, { ...range, diff: normPath(diff), queueDir: normPath(this.store.queueDir(q.id)) });
    writeFileSync(join(dir, "packet.md"), packet, "utf8");
    const briefing = helperBriefing(state.project);
    const env = this.host.env(id);
    const launch = (resume: boolean): Launch => on.runtime === "codex"
      ? { runtime: "codex", options: {
        cwd: dir, model: on.model, effort: on.effort, instructions: briefing, env, threadId: null,
        sandbox: "workspace-write", approvalPolicy: "never", writableRoots: [dir], withoutUserTools: true,
      } }
      : { runtime: "claude", options: {
        cwd: checkout, uuid: session.native_id!, resume, model: on.model, effort: on.effort, permissionMode: "dontAsk",
        allowedTools: HELPER_TOOLS, disallowedTools: HELPER_DENIED, appendSystemPrompt: briefing, env,
      } };
    const tag = () => ({ queue: q.id, step: st.id });
    const l = this.host.start(session, launch, {}, (l) => ({
      tag,
      activity: (a) => this.store.appendActivity(id, { at: now(), ...a, ...tag() }),
      refusal: (r) => {
        if (r.ref && this.store.readRefusals(id).entries.some((x) => x.ref === r.ref)) return;
        this.store.appendRefusal({ at: now(), session: id, runtime: on.runtime, ...r, ...tag() });
        this.changed();
      },
      // One turn: the verdict is given within it, and the process ends after it.
      turnEnd: (end) => {
        if (!end.ok) l.failure = end.failure ? `${end.failure.code}: ${end.failure.text}` : "its turn was interrupted";
        clearTimeout(l.timer);
        this.host.retire(id);
      },
      exit: () => { clearTimeout(l.timer); this.ended(id, l); this.changed(); },
    }));
    l.timer = setTimeout(() => { l.timedOut = true; this.host.retire(id); l.proc.kill(); }, this.limitMs);
    l.timer.unref();
    this.host.send(l, packet);
  }

  /**
   * The helper's process ended: without a verdict, while its step still waits for it, Nexus passes the step on (H8).
   * Not when the server stops: the next one starts the helper again.
   */
  private ended(id: string, l: Hosted<Extra>): void {
    if (this.stopped) return;
    if (this.store.readEvents(id).entries.some((e) => HELPER_VERDICTS.has(e.type))) return;
    const state = loadProjectState(this.store);
    const a = helperAbout(this.store.readSession(id));
    const q = a && state.queues.find((x) => x.id === a.queue);
    const st = q?.steps.find((x) => x.id === a!.step);
    if (!q || !st || st.helper?.state !== "running" || st.helper.session !== id) return;
    if (l.failure && !l.timedOut) this.passOn(q, st, a!.round, ["unavailable"], `The review helper's turn failed: ${l.failure}.`);
    else this.passOn(q, st, a!.round, ["no_verdict"], l.timedOut ? `The review helper gave no verdict within ${Math.round(this.limitMs / 60_000)} minutes.` : "The review helper ended without a verdict.");
  }

  /**
   * Writes the step's whole diff (H4): from its first round's start (git.yaml) to the commit its latest round reported,
   * else the checkout's HEAD; returns its --stat and the ranges. Without a recorded start (no git), an empty diff.
   */
  private diff(q: QueueView, st: StepView, cwd: string, file: string): { stat: string; range: { from: string; to: string; round?: { from: string; to: string } } } {
    const segments = this.store.readGit(q.id)?.steps[st.id] ?? [];
    const from = segments.find((x) => x.start)?.start;
    const git = (args: string[]) => perf.measure(gitLabel(args), () => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 256 * 1024 * 1024 }));
    let to = st.commit;
    try { to ??= git(["rev-parse", "HEAD"]).trim(); } catch { to = undefined; }
    if (!from || !to) {
      writeFileSync(file, "", "utf8");
      return { stat: "(no git range recorded for this step)", range: { from: from ?? "-", to: to ?? "-" } };
    }
    try {
      writeFileSync(file, git(["diff", from, to]), "utf8");
      const last = segments.findLast((x) => x.start)?.start ?? from;
      return { stat: git(["diff", "--stat", from, to]), range: { from, to, round: { from: last, to } } };
    } catch (e) {
      writeFileSync(file, "", "utf8");
      return { stat: `(git diff failed: ${errorText(e).split("\n")[0]})`, range: { from, to } };
    }
  }
}

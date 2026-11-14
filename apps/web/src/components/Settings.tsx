// A project's settings: how its agents run (runtime, model, effort, permissions) and its defaults.
import { useState, type ReactNode } from "react";
import type { ProjectFile } from "@nexus/protocol";
import { act, useFetch } from "../api.ts";
import { Button, Section } from "./ui.tsx";
import { CHOICES, readChoice, setChoice, type ThemeChoice } from "../theme.ts";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const field = "w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg placeholder:text-fg-3";

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1 py-1.5 sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-3">
      <span className="pt-1 text-sm text-fg">{label}</span>
      <span className="min-w-0">{children}{hint && <span className="mt-1 block text-xs text-fg-3">{hint}</span>}</span>
    </label>
  );
}

function Select({ value, onChange, options, empty }: { value: string; onChange: (v: string) => void; options: readonly string[] | [string, string][]; empty?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Project settings" className="rounded-md p-1.5 text-fg-3 hover:bg-surface hover:text-fg">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    </button>
  );
}

interface Orch { model: string | null; effort: string | null }

export function SettingsPanel({ project, onChanged, server, tools }: {
  project: ProjectFile; onChanged: () => void; server?: ServerInfo;
  /** On the phone, where the header has no icon row: the update, the usage, notifications and remote access. */
  tools?: ReactNode;
}) {
  const orch = useFetch<Orch>(`/api/projects/${encodeURIComponent(project.id)}/orchestrator`, project);
  const [f, setF] = useState(() => ({
    name: project.name,
    runtime: project.runtimes.default,
    claudeModel: project.runtimes.claude.model ?? "",
    claudeEffort: project.runtimes.claude.effort ?? "",
    claudePermission: project.runtimes.claude.permission_mode,
    claudeTools: project.runtimes.claude.allowed_tools.join("\n"),
    codexModel: project.runtimes.codex.model ?? "",
    codexEffort: project.runtimes.codex.effort ?? "",
    codexSandbox: project.runtimes.codex.sandbox,
    codexApproval: project.runtimes.codex.approval_policy,
    codexReviewer: project.runtimes.codex.approvals_reviewer ?? "",
    notesDir: project.conversations.notes_dir ?? "",
    ideasRuntime: project.conversations.runtime,
    ideasModel: project.conversations.model ?? "",
    ideasEffort: project.conversations.effort ?? "",
    orchModel: undefined as string | undefined,
    orchEffort: undefined as string | undefined,
    notify: project.orchestrator?.notify ?? true,
    review: project.defaults.review_policy,
    usage: Math.round(project.defaults.usage_pause_threshold * 100),
    reuse: Math.round(project.defaults.context_reuse_threshold * 100),
    care: project.defaults.context_care,
    protectNexus: project.defaults.protect_nexus,
    pushAccepted: project.defaults.push_accepted,
    worktrees: project.defaults.worktree_dir ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const orchModel = f.orchModel ?? orch?.model ?? "";
  const orchEffort = f.orchEffort ?? orch?.effort ?? "";

  const save = async () => {
    setBusy(true); setMsg(undefined);
    try {
      await act(project.id, "PATCH", "/settings", {
        name: f.name,
        runtimes: {
          default: f.runtime,
          claude: { model: f.claudeModel || null, effort: f.claudeEffort || null, permission_mode: f.claudePermission, allowed_tools: f.claudeTools.split(/\n|,/).map((x) => x.trim()).filter(Boolean) },
          codex: { model: f.codexModel || null, effort: f.codexEffort || null, sandbox: f.codexSandbox, approval_policy: f.codexApproval, approvals_reviewer: f.codexReviewer || null },
        },
        orchestrator: { notify: f.notify },
        conversations: { notes_dir: f.notesDir || null, runtime: f.ideasRuntime, model: f.ideasModel || null, effort: f.ideasEffort || null },
        defaults: { review_policy: f.review, usage_pause_threshold: f.usage / 100, context_reuse_threshold: f.reuse / 100, context_care: f.care, protect_nexus: f.protectNexus, push_accepted: f.pushAccepted, worktree_dir: f.worktrees || null },
      });
      if (f.orchModel !== undefined || f.orchEffort !== undefined) {
        await act(project.id, "POST", "/orchestrator/settings", { model: orchModel || null, effort: orchEffort || null });
      }
      setMsg({ ok: true, text: "Saved. New settings apply to runs started from now on (and to the orchestrator's next message)." });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const claudeAuto = f.claudePermission === "auto";
  const codexAuto = f.codexApproval === "on-request" && f.codexReviewer === "auto_review";
  return (
    <div>
      <div className="break-all pr-8 text-xs text-fg-3">{project.root}</div>
      <h2 className="mt-1 pr-8 text-xl font-semibold text-fg">Project settings</h2>
      {tools && <div className="mt-6">{tools}</div>}

      <Section title="General">
        <Row label="Name"><input value={f.name} onChange={(e) => set("name", e.target.value)} className={field} /></Row>
        <Row label="Default runtime" hint="Used when a run is started without naming one.">
          <Select value={f.runtime} onChange={(v) => set("runtime", v as "claude" | "codex")} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />
        </Row>
      </Section>

      <Section title="Claude Code workers">
        <Row label="Model">
          <ModelSelect runtime="claude" value={f.claudeModel} onChange={(v) => set("claudeModel", v)} defaultLabel="Claude Code's default" className="w-full" />
        </Row>
        <Row label="Effort"><EffortSelect runtime="claude" model={f.claudeModel} value={f.claudeEffort} onChange={(v) => set("claudeEffort", v)} className="w-full" /></Row>
        <Row label="Permissions" hint={claudeAuto ? "Auto: routine actions run, risky ones are refused by Claude Code's classifier. Nobody is asked: a refusal is reported to the agent." : "Nobody can answer a prompt while Nexus runs: what is not allowed is refused."}>
          <Select value={f.claudePermission} onChange={(v) => set("claudePermission", v as typeof f.claudePermission)} options={[
            ["auto", "auto (recommended for unattended runs)"], ["acceptEdits", "acceptEdits: file edits, plus the allow list"],
            ["dontAsk", "dontAsk: only the allow list"], ["bypassPermissions", "bypassPermissions: everything (risky)"], ["plan", "plan: read only"],
          ]} />
        </Row>
        <Row label="Also allowed" hint="One rule per line, as in Claude Code's settings (Bash(git commit:*), WebFetch…). The project's own .claude/settings.json applies too.">
          <textarea value={f.claudeTools} onChange={(e) => set("claudeTools", e.target.value)} rows={3} className={`${field} font-mono text-xs`} />
        </Row>
        <Row label="Keep out of .nexus" hint="Workers' file tools (Write, Edit) may not write under the project's .nexus folder, where Nexus keeps its records; the nexus command still records their reports. Shell commands are not covered. Codex workers cannot be kept out: its Windows sandbox refuses a read-only folder the nexus command must still write in.">
          <span className="flex items-center gap-2 pt-1 text-sm text-fg">
            <input type="checkbox" checked={f.protectNexus} onChange={(e) => set("protectNexus", e.target.checked)} className="accent-accent" />
            workers may not write under .nexus
          </span>
        </Row>
      </Section>

      <Section title="Codex workers">
        <Row label="Model">
          <ModelSelect runtime="codex" value={f.codexModel} onChange={(v) => set("codexModel", v)} defaultLabel="Codex's default" className="w-full" />
        </Row>
        <Row label="Effort"><EffortSelect runtime="codex" model={f.codexModel} value={f.codexEffort} onChange={(v) => set("codexEffort", v)} className="w-full" /></Row>
        <Row label="Sandbox"><Select value={f.codexSandbox} onChange={(v) => set("codexSandbox", v as typeof f.codexSandbox)} options={[["workspace-write", "workspace-write (recommended)"], ["read-only", "read-only"], ["danger-full-access", "danger-full-access (risky)"]]} /></Row>
        <Row label="Leaving the sandbox" hint={codexAuto ? "Auto review: Codex's reviewer approves or refuses each request by its risk, like Claude Code's auto mode." : f.codexApproval === "never" ? "Never: anything outside the sandbox (network, files elsewhere) is refused." : "Requests go to the reviewer chosen here; one Nexus cannot answer is refused."}>
          <Select value={f.codexApproval === "on-request" && f.codexReviewer === "auto_review" ? "auto" : f.codexApproval} onChange={(v) => {
            if (v === "auto") { set("codexApproval", "on-request"); set("codexReviewer", "auto_review"); }
            else { set("codexApproval", v as typeof f.codexApproval); set("codexReviewer", ""); }
          }} options={[["auto", "auto review (recommended)"], ["never", "never: always refused"], ["on-request", "on request (no reviewer: refused)"]]} />
        </Row>
      </Section>

      <Section title="Orchestrator">
        <Row label="Model" hint="Applies from its next message; the conversation goes on.">
          <ModelSelect runtime="claude" value={orchModel} onChange={(v) => set("orchModel", v)} defaultLabel="Claude Code's default" className="w-full" />
        </Row>
        <Row label="Effort"><EffortSelect runtime="claude" model={orchModel} value={orchEffort} onChange={(v) => set("orchEffort", v)} className="w-full" /></Row>
        <Row label="Tell it about"><span className="flex items-center gap-2 pt-1 text-sm text-fg">
          <input type="checkbox" checked={f.notify} onChange={(e) => set("notify", e.target.checked)} className="accent-accent" />
          workers' questions, and runs that halt or finish
        </span></Row>
      </Section>

      <Section title="Ideas (conversations)">
        <Row label="Notes folder" hint="The one folder a thinking partner may write in, relative to the project (e.g. Dev/Concepts/Gameplay). Empty: they only read.">
          <input value={f.notesDir} onChange={(e) => set("notesDir", e.target.value)} placeholder="read only" className={`${field} font-mono text-xs`} />
        </Row>
        <Row label="Runtime"><Select value={f.ideasRuntime} onChange={(v) => { set("ideasRuntime", v as "claude" | "codex"); set("ideasModel", ""); set("ideasEffort", ""); }} options={[["claude", "Claude Code"], ["codex", "Codex"]]} /></Row>
        <Row label="Model"><ModelSelect runtime={f.ideasRuntime} value={f.ideasModel} onChange={(v) => set("ideasModel", v)} defaultLabel="the runtime's default" className="w-full" /></Row>
        <Row label="Effort"><EffortSelect runtime={f.ideasRuntime} model={f.ideasModel} value={f.ideasEffort} onChange={(v) => set("ideasEffort", v)} className="w-full" /></Row>
      </Section>

      <Section title="Defaults">
        <Row label="After each step" hint={f.review === "orchestrator" ? "The orchestrator accepts each step, sends it back, or hands it to you; without an orchestrator, or with its notices off, the step waits for you." : undefined}><Select value={f.review} onChange={(v) => set("review", v as "continue" | "wait" | "orchestrator")} options={[["continue", "go on to the next step"], ["wait", "wait for my review"], ["orchestrator", "wait for the orchestrator's review"]]} /></Row>
        <Row label="Push what was accepted" hint="When a step is accepted (by you or the orchestrator), Nexus pushes the commit the step was reviewed at to the branch the queue runs on (its upstream remote, else origin). Never forced; a failed push shows on the step.">
          <span className="flex items-center gap-2 pt-1 text-sm text-fg">
            <input type="checkbox" checked={f.pushAccepted} onChange={(e) => set("pushAccepted", e.target.checked)} className="accent-accent" />
            push accepted steps
          </span>
        </Row>
        <Row label="Pause new steps at" hint="Share of a usage window (Claude's 5 hours, Codex's windows) above which no new step starts.">
          <span className="flex items-center gap-2"><input type="number" min={10} max={100} value={f.usage} onChange={(e) => set("usage", Number(e.target.value))} className={`${field} w-24`} /> %</span>
        </Row>
        <Row label="Reuse a session up to" hint="The orchestrator continues a session only below this context fill; with context care on, so does a run from one step to the next.">
          <span className="flex items-center gap-2"><input type="number" min={10} max={100} value={f.reuse} onChange={(e) => set("reuse", Number(e.target.value))} className={`${field} w-24`} /> %</span>
        </Row>
        <Row label="Context care" hint="Above that fill at the end of a step, the next step runs in a fresh session, given the previous one's context summary, instead of the runtime compacting in the middle of a step.">
          <span className="flex items-center gap-2 pt-1 text-sm text-fg">
            <input type="checkbox" checked={f.care} onChange={(e) => set("care", e.target.checked)} className="accent-accent" />
            a fresh session when the context is full
          </span>
        </Row>
        <Row label="Worktrees in" hint="Where Nexus creates worktrees for queues that ask for one; empty: next to the project.">
          <input value={f.worktrees} onChange={(e) => set("worktrees", e.target.value)} placeholder={`${project.root}/../…worktrees`} className={`${field} font-mono text-xs`} />
        </Row>
      </Section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
      </div>

      <BrowserSection />
      <ServerSection info={server} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------- this browser

/** What this browser keeps for itself, for every project: the theme. Applies at once; nothing to save. */
function BrowserSection() {
  const [choice, setLocal] = useState<ThemeChoice>(readChoice);
  return (
    <Section title="This browser">
      <Row label="Theme" hint="Kept in this browser only, for every project; other devices keep their own.">
        <Select value={choice} onChange={(v) => { setChoice(v as ThemeChoice); setLocal(v as ThemeChoice); }}
          options={CHOICES.map((c) => [c.value, c.label] as [string, string])} />
      </Row>
    </Section>
  );
}

// ---------------------------------------------------------------- Nexus itself

export interface ServerInfo {
  commit: string; subject: string; live: boolean; branch: string | null; root: string;
  update: {
    phase: "idle" | "draining" | "updating" | "restarting" | "failed" | "updated"; held: string[]; waiting: string[]; log: string[]; error?: string; now?: boolean;
    /** After a deploy: whether the deployed main was pushed. */
    push?: { result: "pushed" | "failed" | "skipped"; text: string; at: string };
  };
  /** Whether a deploy pushes the deployed main to its upstream. */
  push_on_deploy: boolean;
  /** How many queues may run at once, across all projects. */
  max_running?: number;
}

const PUSH_TONE = { pushed: "text-ok", failed: "text-danger", skipped: "text-fg-2" } as const;
const PUSH_LABEL = { pushed: "Pushed", failed: "Push failed", skipped: "Not pushed" } as const;

export function useServer(version: unknown) {
  return useFetch<ServerInfo>("/api/server", version);
}

/** A pill in the header while Nexus updates itself. */
export function UpdatePill({ info }: { info: ServerInfo | undefined }) {
  const u = info?.update;
  if (!u || u.phase === "idle" || u.phase === "updated") return null;
  const text = u.phase === "draining" ? (u.waiting.length ? `updating: waiting for ${u.waiting.length} project${u.waiting.length > 1 ? "s" : ""}` : "updating")
    : u.phase === "failed" ? "update failed" : u.phase;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium ${u.phase === "failed" ? "text-danger" : "text-accent"}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${u.phase === "failed" ? "bg-danger" : "animate-pulse bg-accent"}`} />{text}
    </span>
  );
}

export function ServerSection({ info, onChanged }: { info: ServerInfo | undefined; onChanged: () => void }) {
  const [msg, setMsg] = useState<string>();
  if (!info) return null;
  const u = info.update;
  const call = async (path: string, body: unknown = {}) => {
    setMsg(undefined);
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) setMsg((await r.json().catch(() => ({}))).error ?? r.statusText);
    onChanged();
  };
  const busy = u.phase === "draining" || u.phase === "updating" || u.phase === "restarting";
  return (
    <Section title="Nexus">
      <p className="text-sm text-fg">
        <span className="font-mono">{info.commit}</span> {info.subject}
      </p>
      <p className="mt-1 text-xs text-fg-3">
        {info.live ? "Live instance" : `Development checkout (branch ${info.branch}): an update rebuilds and restarts it without moving it`} · <span className="font-mono">{info.root}</span>
      </p>
      {u.phase !== "idle" && (
        <div className="mt-3 rounded-lg bg-canvas p-3 text-xs text-fg-2">
          <div className="mb-1 text-fg">{u.phase === "updated" ? <>Updated: <span className="font-mono">{info.commit}</span> is up</> : <>Update: {u.phase}</>}{busy && u.held.length ? `; holding ${u.held.join(", ")}` : ""}{u.waiting.length ? `; waiting for ${u.waiting.join(", ")}` : ""}</div>
          {u.push && <div className={`mb-1 ${PUSH_TONE[u.push.result]}`}><span className="font-semibold">{PUSH_LABEL[u.push.result]}:</span> {u.push.text}</div>}
          {u.log.map((l, i) => <div key={i} className="font-mono">{l}</div>)}
          {u.error && <div className="mt-1 whitespace-pre-wrap text-danger">{u.error}</div>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!busy && <Button onClick={() => void call("/api/server/update")}>Update Nexus</Button>}
        {!busy && <Button variant="quiet" onClick={() => { if (confirm("Stop the running steps now? They continue from where they were after the restart.")) void call("/api/server/update", { now: true }); }}>Update now</Button>}
        {u.phase === "draining" && <Button variant="quiet" onClick={() => void call("/api/server/cancel")}>Cancel</Button>}
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm text-fg">
        <input type="checkbox" className="mt-0.5 accent-accent" checked={info.push_on_deploy}
          onChange={(e) => void call("/api/server/settings", { push_on_deploy: e.target.checked })} />
        <span>Push the deployed main to GitHub after an update{info.live ? "" : " (only a live instance pushes)"}</span>
      </label>
      {info.max_running !== undefined && (
        <div className="mt-3 text-sm text-fg">
          <label className="flex flex-wrap items-center gap-2">
            <span>Queues running at once, across all projects:</span>
            <select className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg" value={info.max_running}
              onChange={(e) => void call("/api/server/settings", { max_running: Number(e.target.value) })}>
              {[...new Set([...Array.from({ length: 10 }, (_, i) => i + 1), info.max_running])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <p className="mt-1 text-xs text-fg-3">
            Queues run side by side only in worktrees of their own, never two in one checkout. A queue waiting for a
            review or an answer does not count. A start over the limit, or into a checkout another queue holds, is
            refused; a chain or a schedule waits and starts by itself once it may.
          </p>
        </div>
      )}
      <p className="mt-2 text-xs text-fg-3">
        Update Nexus lets every running step finish (new steps wait), moves this instance to the newest commit on main,
        builds it and restarts. The queues it held go on by themselves; paused or stopped ones stay as they are. Once the
        new version is up, it pushes that commit of main to its upstream, fast-forward only; a failed push leaves the
        update in place and says why here.
      </p>
      {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- choosing a model


interface ModelInfo { value: string; label: string; description?: string; efforts?: string[] }

/**
 * A model, chosen from the list the runtime itself gives (Claude Code's and Codex's own model lists). "Other…" takes
 * a full model name for the rare case; a saved name not in the list is shown as it is.
 */
export function ModelSelect({ runtime, value, onChange, defaultLabel = "default", className = "", disabled }: {
  runtime: "claude" | "codex"; value: string; onChange: (v: string) => void; defaultLabel?: string; className?: string; disabled?: boolean;
}) {
  const models = useFetch<ModelInfo[]>(`/api/models/${runtime}`, runtime);
  const [typing, setTyping] = useState(false);
  const options: [string, string, string?][] = (models ?? []).map((m) => [m.value, m.label, m.description]);
  if (value && !options.some(([v]) => v === value)) options.push([value, value]);
  const style = `rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-50 ${className}`;
  if (typing) {
    return (
      <span className="flex items-center gap-1">
        <input autoFocus value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="full model name" className={style} />
        <button type="button" onClick={() => setTyping(false)} className="px-1 text-xs text-fg-2 hover:text-fg" title="Back to the list">list</button>
      </span>
    );
  }
  return (
    <select value={value} disabled={disabled} className={style}
      onChange={(e) => { if (e.target.value === "\u0000other") { setTyping(true); onChange(""); } else onChange(e.target.value); }}>
      <option value="">{defaultLabel}</option>
      {options.map(([v, l, d]) => <option key={v} value={v} title={d}>{l}{d ? ` · ${d}` : ""}</option>)}
      {!models && <option disabled value={"\u0000loading"}>loading the models…</option>}
      <option value={"\u0000other"}>Other…</option>
    </select>
  );
}

/**
 * The effort levels a model takes, from the runtime's own model list: the chosen model's, or, for the runtime's
 * default model, every level some model takes.
 */
export function useEfforts(runtime: "claude" | "codex", model: string): string[] {
  const models = useFetch<ModelInfo[]>(`/api/models/${runtime}`, runtime);
  const fallback = runtime === "claude" ? [...CLAUDE_EFFORTS] : ["low", "medium", "high", "xhigh"];
  if (!models?.length) return fallback;
  const chosen = models.find((m) => m.value === model)?.efforts;
  if (chosen?.length) return chosen;
  const all = new Set(models.flatMap((m) => m.efforts ?? []));
  const order = ["low", "medium", "high", "xhigh", "max", "ultra"];
  return all.size ? order.filter((e) => all.has(e)) : fallback;
}

export function EffortSelect({ runtime, model, value, onChange, defaultLabel = "default", className = "", disabled }: {
  runtime: "claude" | "codex"; model: string; value: string; onChange: (v: string) => void; defaultLabel?: string; className?: string; disabled?: boolean;
}) {
  const efforts = useEfforts(runtime, model);
  const options = value && !efforts.includes(value) ? [...efforts, value] : efforts;
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-50 ${className}`}>
      <option value="">{defaultLabel}</option>
      {options.map((x) => <option key={x} value={x}>{x}{efforts.includes(x) ? "" : " (not offered by this model)"}</option>)}
    </select>
  );
}

// A project's settings: how its agents run (runtime, model, effort, permissions) and its defaults.
import { useState, type ReactNode } from "react";
import type { ProjectFile } from "@nexus/protocol";
import { act, useFetch } from "../api.ts";
import { Button, Section } from "./ui.tsx";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

const field = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600";

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1 py-1.5 sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-3">
      <span className="pt-1 text-sm text-zinc-300">{label}</span>
      <span className="min-w-0">{children}{hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}</span>
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
    <button onClick={onClick} title="Project settings" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    </button>
  );
}

interface Orch { model: string | null; effort: string | null }

export function SettingsPanel({ project, onChanged }: { project: ProjectFile; onChanged: () => void }) {
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
    orchModel: undefined as string | undefined,
    orchEffort: undefined as string | undefined,
    notify: project.orchestrator?.notify ?? true,
    review: project.defaults.review_policy,
    usage: Math.round(project.defaults.usage_pause_threshold * 100),
    reuse: Math.round(project.defaults.context_reuse_threshold * 100),
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
        defaults: { review_policy: f.review, usage_pause_threshold: f.usage / 100, context_reuse_threshold: f.reuse / 100, worktree_dir: f.worktrees || null },
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
      <div className="text-xs text-zinc-500">{project.root}</div>
      <h2 className="mt-1 pr-8 text-xl font-semibold text-zinc-50">Project settings</h2>

      <Section title="General">
        <Row label="Name"><input value={f.name} onChange={(e) => set("name", e.target.value)} className={field} /></Row>
        <Row label="Default runtime" hint="Used when a run is started without naming one.">
          <Select value={f.runtime} onChange={(v) => set("runtime", v as "claude" | "codex")} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />
        </Row>
      </Section>

      <Section title="Claude Code workers">
        <Row label="Model" hint="An alias (opus, sonnet, haiku) or a full model name; empty: Claude Code's default.">
          <input value={f.claudeModel} onChange={(e) => set("claudeModel", e.target.value)} placeholder="default" list="claude-models" className={field} />
          <datalist id="claude-models"><option value="opus" /><option value="sonnet" /><option value="haiku" /></datalist>
        </Row>
        <Row label="Effort"><Select value={f.claudeEffort} onChange={(v) => set("claudeEffort", v)} options={CLAUDE_EFFORTS} empty="default" /></Row>
        <Row label="Permissions" hint={claudeAuto ? "Auto: routine actions run, risky ones are refused by Claude Code's classifier. Nobody is asked: a refusal is reported to the agent." : "Nobody can answer a prompt while Nexus runs: what is not allowed is refused."}>
          <Select value={f.claudePermission} onChange={(v) => set("claudePermission", v as typeof f.claudePermission)} options={[
            ["auto", "auto (recommended for unattended runs)"], ["acceptEdits", "acceptEdits: file edits, plus the allow list"],
            ["dontAsk", "dontAsk: only the allow list"], ["bypassPermissions", "bypassPermissions: everything (risky)"], ["plan", "plan: read only"],
          ]} />
        </Row>
        <Row label="Also allowed" hint="One rule per line, as in Claude Code's settings (Bash(git commit:*), WebFetch…). The project's own .claude/settings.json applies too.">
          <textarea value={f.claudeTools} onChange={(e) => set("claudeTools", e.target.value)} rows={3} className={`${field} font-mono text-xs`} />
        </Row>
      </Section>

      <Section title="Codex workers">
        <Row label="Model" hint="Empty: Codex's default (from its own config).">
          <input value={f.codexModel} onChange={(e) => set("codexModel", e.target.value)} placeholder="default" className={field} />
        </Row>
        <Row label="Effort"><Select value={f.codexEffort} onChange={(v) => set("codexEffort", v)} options={CODEX_EFFORTS} empty="default" /></Row>
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
          <input value={orchModel} onChange={(e) => set("orchModel", e.target.value)} placeholder="default" list="claude-models" className={field} />
        </Row>
        <Row label="Effort"><Select value={orchEffort} onChange={(v) => set("orchEffort", v)} options={CLAUDE_EFFORTS} empty="default" /></Row>
        <Row label="Tell it about"><span className="flex items-center gap-2 pt-1 text-sm text-zinc-300">
          <input type="checkbox" checked={f.notify} onChange={(e) => set("notify", e.target.checked)} className="accent-sky-500" />
          workers' questions, and runs that halt or finish
        </span></Row>
      </Section>

      <Section title="Defaults">
        <Row label="After each step"><Select value={f.review} onChange={(v) => set("review", v as "continue" | "wait")} options={[["continue", "go on to the next step"], ["wait", "wait for my review"]]} /></Row>
        <Row label="Pause new steps at" hint="Share of a usage window (Claude's 5 hours, Codex's windows) above which no new step starts.">
          <span className="flex items-center gap-2"><input type="number" min={10} max={100} value={f.usage} onChange={(e) => set("usage", Number(e.target.value))} className={`${field} w-24`} /> %</span>
        </Row>
        <Row label="Reuse a session up to" hint="The orchestrator continues a session only below this context fill.">
          <span className="flex items-center gap-2"><input type="number" min={10} max={100} value={f.reuse} onChange={(e) => set("reuse", Number(e.target.value))} className={`${field} w-24`} /> %</span>
        </Row>
        <Row label="Worktrees in" hint="Where Nexus creates worktrees for queues that ask for one; empty: next to the project.">
          <input value={f.worktrees} onChange={(e) => set("worktrees", e.target.value)} placeholder={`${project.root}/../…worktrees`} className={`${field} font-mono text-xs`} />
        </Row>
      </Section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

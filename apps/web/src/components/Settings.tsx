// Settings: the global ones every project follows, and a project's own (how its agents run, its defaults), each
// setting with a global value switched between following it and the project's own value (PROTOCOL.md, "Global settings").
import { useState, type ReactNode } from "react";
import type { GlobalSettings, ProjectFile } from "@nexus/protocol";
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

function Select({ value, onChange, options, empty, disabled }: { value: string; onChange: (v: string) => void; options: readonly string[] | [string, string][]; empty?: string; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={field}>
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

// ---------------------------------------------------------------- the settings: one form for the global page and a project's

/** The global settings and which settings a project has its own value of (GET /api/projects/:id/settings). */
interface ProjectSettingsInfo { own: string[]; global: GlobalSettings }

type Values = Record<string, unknown>;
const at = (o: unknown, key: string): unknown => key.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Values)[k] : undefined), o);
/** The settings that are global with a project override, by key, from a project's (effective) or the global settings. */
const valuesOf = (o: unknown): Values => Object.fromEntries(SETTING_KEYS.map((k) => [k, at(o, k)]));
/** Nested settings from keys and values, for a write: an empty optional value is sent as null (none). */
function nested(values: Values, keys: readonly string[]): Values {
  const out: Values = {};
  for (const k of keys) {
    const path = k.split(".");
    let x = out;
    for (const p of path.slice(0, -1)) x = (x[p] ??= {}) as Values;
    const v = values[k];
    x[path.at(-1)!] = v === "" || v === undefined ? null : v;
  }
  return out;
}

/** Every setting with a global value, in the order of PROTOCOL.md's list. */
const SETTING_KEYS = [
  "defaults.stop_conditions", "defaults.review_policy", "defaults.review_send_back_limit", "defaults.context_reuse_threshold",
  "defaults.context_care", "defaults.protect_nexus", "defaults.push_accepted", "defaults.usage_pause_threshold",
  "runtimes.default", "runtimes.claude.model", "runtimes.claude.effort", "runtimes.claude.permission_mode",
  "runtimes.codex.model", "runtimes.codex.effort", "runtimes.codex.sandbox", "runtimes.codex.approval_policy", "runtimes.codex.approvals_reviewer",
  "conversations.runtime", "conversations.model", "conversations.effort",
  "orchestrator.runtime", "orchestrator.model", "orchestrator.effort", "orchestrator.notify",
] as const;

/**
 * What a row needs: the value of a setting, its change, and on a project's page whether it follows the global value
 * (then its control shows the global value, greyed, and cannot be changed until the row is switched to its own).
 */
interface Form {
  get: (k: string) => string;
  bool: (k: string) => boolean;
  set: (k: string, v: unknown) => void;
  /** On the global page: undefined. On a project's page: whether these settings follow the global values. */
  follows?: (keys: readonly string[]) => boolean;
  toggle?: (keys: readonly string[], own: boolean) => void;
}

/**
 * A row for settings that are global with a project override. On a project's page it has a switch: Global (the
 * control shows the global value, greyed, marked "global") or Own (the project's own value, editable).
 */
function Setting({ form, keys, label, hint, children }: { form: Form; keys: readonly string[]; label: string; hint?: ReactNode; children: (disabled: boolean) => ReactNode }) {
  const follows = form.follows?.(keys) ?? false;
  return (
    <div className="grid gap-1 py-1.5 sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-3">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm text-fg">
        {label}
        {follows && <span className="rounded bg-surface-2 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-fg-3" title="This project follows the global value">global</span>}
      </span>
      <span className="min-w-0">
        <span className="flex items-start gap-2">
          <span className={`min-w-0 flex-1 ${follows ? "opacity-50" : ""}`}>{children(follows)}</span>
          {form.toggle && (
            <span className="inline-flex shrink-0 overflow-hidden rounded-md border border-line-strong text-xs" role="group" aria-label={`${label}: global or own value`}>
              <button type="button" onClick={() => form.toggle!(keys, false)} aria-pressed={follows}
                className={`px-2 py-1 ${follows ? "bg-surface-2 text-fg" : "text-fg-3 hover:text-fg"}`}>Global</button>
              <button type="button" onClick={() => form.toggle!(keys, true)} aria-pressed={!follows}
                className={`border-l border-line-strong px-2 py-1 ${!follows ? "bg-accent/15 text-fg" : "text-fg-3 hover:text-fg"}`}>Own</button>
            </span>
          )}
        </span>
        {hint && <span className="mt-1 block text-xs text-fg-3">{hint}</span>}
      </span>
    </div>
  );
}

/** A check box row's control. */
function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 pt-1 text-sm text-fg">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {children}
    </span>
  );
}

/** The settings that are global with a project override, in their sections; `project`: the project-only rows beside them. */
function SettingRows({ form, project }: { form: Form; project?: { values: Record<string, string>; set: (k: string, v: string) => void; root: string } }) {
  const f = form;
  const claudeModel = f.get("runtimes.claude.model"), codexModel = f.get("runtimes.codex.model"), ideasRuntime = f.get("conversations.runtime") as "claude" | "codex";
  const claudeAuto = f.get("runtimes.claude.permission_mode") === "auto";
  const approval = f.get("runtimes.codex.approval_policy"), reviewer = f.get("runtimes.codex.approvals_reviewer");
  const codexAuto = approval === "on-request" && reviewer === "auto_review";
  const p = project;
  return (
    <>
      <Section title="General">
        {p && <Row label="Name"><input value={p.values.name} onChange={(e) => p.set("name", e.target.value)} className={field} /></Row>}
        <Setting form={f} keys={["runtimes.default"]} label="Default runtime" hint="Used when a run is started without naming one.">
          {(d) => <Select value={f.get("runtimes.default")} onChange={(v) => f.set("runtimes.default", v)} disabled={d} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />}
        </Setting>
      </Section>

      <Section title="Claude Code workers">
        <Setting form={f} keys={["runtimes.claude.model"]} label="Model">
          {(d) => <ModelSelect runtime="claude" value={claudeModel} onChange={(v) => f.set("runtimes.claude.model", v)} disabled={d} defaultLabel="Claude Code's default" className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.claude.effort"]} label="Effort">
          {(d) => <EffortSelect runtime="claude" model={claudeModel} value={f.get("runtimes.claude.effort")} onChange={(v) => f.set("runtimes.claude.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.claude.permission_mode"]} label="Permissions" hint={claudeAuto ? "Auto: routine actions run, risky ones are refused by Claude Code's classifier. Nobody is asked: a refusal is reported to the agent." : "Nobody can answer a prompt while Nexus runs: what is not allowed is refused."}>
          {(d) => <Select value={f.get("runtimes.claude.permission_mode")} onChange={(v) => f.set("runtimes.claude.permission_mode", v)} disabled={d} options={[
            ["auto", "auto (recommended for unattended runs)"], ["acceptEdits", "acceptEdits: file edits, plus the allow list"],
            ["dontAsk", "dontAsk: only the allow list"], ["bypassPermissions", "bypassPermissions: everything (risky)"], ["plan", "plan: read only"],
          ]} />}
        </Setting>
        {p && (
          <Row label="Also allowed" hint="One rule per line, as in Claude Code's settings (Bash(git commit:*), WebFetch…). The project's own .claude/settings.json applies too.">
            <textarea value={p.values.tools} onChange={(e) => p.set("tools", e.target.value)} rows={3} className={`${field} font-mono text-xs`} />
          </Row>
        )}
        <Setting form={f} keys={["defaults.protect_nexus"]} label="Keep out of .nexus" hint="Workers' file tools (Write, Edit) may not write under the project's .nexus folder, where Nexus keeps its records; the nexus command still records their reports. Shell commands are not covered. Codex workers cannot be kept out: its Windows sandbox refuses a read-only folder the nexus command must still write in.">
          {(d) => <Check checked={f.bool("defaults.protect_nexus")} onChange={(v) => f.set("defaults.protect_nexus", v)} disabled={d}>workers may not write under .nexus</Check>}
        </Setting>
      </Section>

      <Section title="Codex workers">
        <Setting form={f} keys={["runtimes.codex.model"]} label="Model">
          {(d) => <ModelSelect runtime="codex" value={codexModel} onChange={(v) => f.set("runtimes.codex.model", v)} disabled={d} defaultLabel="Codex's default" className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.codex.effort"]} label="Effort">
          {(d) => <EffortSelect runtime="codex" model={codexModel} value={f.get("runtimes.codex.effort")} onChange={(v) => f.set("runtimes.codex.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.codex.sandbox"]} label="Sandbox">
          {(d) => <Select value={f.get("runtimes.codex.sandbox")} onChange={(v) => f.set("runtimes.codex.sandbox", v)} disabled={d} options={[["workspace-write", "workspace-write (recommended)"], ["read-only", "read-only"], ["danger-full-access", "danger-full-access (risky)"]]} />}
        </Setting>
        <Setting form={f} keys={["runtimes.codex.approval_policy", "runtimes.codex.approvals_reviewer"]} label="Leaving the sandbox" hint={codexAuto ? "Auto review: Codex's reviewer approves or refuses each request by its risk, like Claude Code's auto mode." : approval === "never" ? "Never: anything outside the sandbox (network, files elsewhere) is refused." : "Requests go to the reviewer chosen here; one Nexus cannot answer is refused."}>
          {(d) => <Select value={codexAuto ? "auto" : approval} disabled={d} onChange={(v) => {
            if (v === "auto") { f.set("runtimes.codex.approval_policy", "on-request"); f.set("runtimes.codex.approvals_reviewer", "auto_review"); }
            else { f.set("runtimes.codex.approval_policy", v); f.set("runtimes.codex.approvals_reviewer", ""); }
          }} options={[["auto", "auto review (recommended)"], ["never", "never: always refused"], ["on-request", "on request (no reviewer: refused)"]]} />}
        </Setting>
      </Section>

      <Section title="Orchestrator">
        <Setting form={f} keys={["orchestrator.model"]} label="Model" hint="Applies from its next message; the conversation goes on.">
          {(d) => <ModelSelect runtime="claude" value={f.get("orchestrator.model")} onChange={(v) => f.set("orchestrator.model", v)} disabled={d} defaultLabel="Claude Code's default" className="w-full" />}
        </Setting>
        <Setting form={f} keys={["orchestrator.effort"]} label="Effort">
          {(d) => <EffortSelect runtime="claude" model={f.get("orchestrator.model")} value={f.get("orchestrator.effort")} onChange={(v) => f.set("orchestrator.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["orchestrator.notify"]} label="Tell it about">
          {(d) => <Check checked={f.bool("orchestrator.notify")} onChange={(v) => f.set("orchestrator.notify", v)} disabled={d}>workers' questions, and runs that halt or finish</Check>}
        </Setting>
      </Section>

      <Section title="Ideas (conversations)">
        {p && (
          <Row label="Notes folder" hint="The one folder a thinking partner may write in, relative to the project (e.g. Dev/Concepts/Gameplay). Empty: they only read.">
            <input value={p.values.notesDir} onChange={(e) => p.set("notesDir", e.target.value)} placeholder="read only" className={`${field} font-mono text-xs`} />
          </Row>
        )}
        <Setting form={f} keys={["conversations.runtime"]} label="Runtime">
          {(d) => <Select value={ideasRuntime} disabled={d} onChange={(v) => { f.set("conversations.runtime", v); f.set("conversations.model", ""); f.set("conversations.effort", ""); }} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />}
        </Setting>
        <Setting form={f} keys={["conversations.model"]} label="Model">
          {(d) => <ModelSelect runtime={ideasRuntime} value={f.get("conversations.model")} onChange={(v) => f.set("conversations.model", v)} disabled={d} defaultLabel="the runtime's default" className="w-full" />}
        </Setting>
        <Setting form={f} keys={["conversations.effort"]} label="Effort">
          {(d) => <EffortSelect runtime={ideasRuntime} model={f.get("conversations.model")} value={f.get("conversations.effort")} onChange={(v) => f.set("conversations.effort", v)} disabled={d} className="w-full" />}
        </Setting>
      </Section>

      <Section title="Defaults">
        <Setting form={f} keys={["defaults.review_policy"]} label="After each step" hint={f.get("defaults.review_policy") === "orchestrator" ? "The orchestrator accepts each step, sends it back, or hands it to you; without an orchestrator, or with its notices off, the step waits for you." : undefined}>
          {(d) => <Select value={f.get("defaults.review_policy")} onChange={(v) => f.set("defaults.review_policy", v)} disabled={d} options={[["continue", "go on to the next step"], ["wait", "wait for my review"], ["orchestrator", "wait for the orchestrator's review"]]} />}
        </Setting>
        <Setting form={f} keys={["defaults.push_accepted"]} label="Push what was accepted" hint="When a step is accepted (by you or the orchestrator), Nexus pushes the commit the step was reviewed at to the branch the queue runs on (its upstream remote, else origin). Never forced; a failed push shows on the step.">
          {(d) => <Check checked={f.bool("defaults.push_accepted")} onChange={(v) => f.set("defaults.push_accepted", v)} disabled={d}>push accepted steps</Check>}
        </Setting>
        <Setting form={f} keys={["defaults.usage_pause_threshold"]} label="Pause new steps at" hint="Share of a usage window (Claude's 5 hours, Codex's windows) above which no new step starts.">
          {(d) => <Percent value={f.get("defaults.usage_pause_threshold")} onChange={(v) => f.set("defaults.usage_pause_threshold", v)} disabled={d} />}
        </Setting>
        <Setting form={f} keys={["defaults.context_reuse_threshold"]} label="Reuse a session up to" hint="The orchestrator continues a session only below this context fill; with context care on, so does a run from one step to the next.">
          {(d) => <Percent value={f.get("defaults.context_reuse_threshold")} onChange={(v) => f.set("defaults.context_reuse_threshold", v)} disabled={d} />}
        </Setting>
        <Setting form={f} keys={["defaults.context_care"]} label="Context care" hint="Above that fill at the end of a step, the next step runs in a fresh session, given the previous one's context summary, instead of the runtime compacting in the middle of a step.">
          {(d) => <Check checked={f.bool("defaults.context_care")} onChange={(v) => f.set("defaults.context_care", v)} disabled={d}>a fresh session when the context is full</Check>}
        </Setting>
        {p && (
          <Row label="Worktrees in" hint="Where Nexus creates worktrees for queues that ask for one; empty: next to the project.">
            <input value={p.values.worktrees} onChange={(e) => p.set("worktrees", e.target.value)} placeholder={`${p.root}/../…worktrees`} className={`${field} font-mono text-xs`} />
          </Row>
        )}
      </Section>
    </>
  );
}

/** A share (0 to 1) shown and typed as a percentage. */
function Percent({ value, onChange, disabled }: { value: string; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <input type="number" min={10} max={100} disabled={disabled} value={Math.round(Number(value) * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} className={`${field} w-24`} /> %
    </span>
  );
}

/** The form's state over the settings with a global value: a key's value as a string for the controls, or a flag. */
function useValues(initial: Values) {
  const [values, setValues] = useState<Values>(initial);
  return {
    values, setValues,
    get: (k: string) => (values[k] === undefined || values[k] === null ? "" : String(values[k])),
    bool: (k: string) => values[k] === true,
    set: (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v })),
  };
}

export function SettingsPanel({ project, onChanged, server, tools }: {
  project: ProjectFile; onChanged: () => void; server?: ServerInfo;
  /** On the phone, where the header has no icon row: the update, the usage, notifications and remote access. */
  tools?: ReactNode;
}) {
  const [tab, setTab] = useState<"project" | "global">("project");
  const info = useFetch<ProjectSettingsInfo>(`/api/projects/${encodeURIComponent(project.id)}/settings`, project);
  return (
    <div>
      <div className="break-all pr-8 text-xs text-fg-3">{tab === "project" ? project.root : "Every project follows these where it has no value of its own"}</div>
      <h2 className="mt-1 pr-8 text-xl font-semibold text-fg">{tab === "project" ? "Project settings" : "Global settings"}</h2>
      <div className="mt-3 inline-flex overflow-hidden rounded-md border border-line-strong text-sm" role="tablist">
        {([["project", project.name], ["global", "Global"]] as const).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-3 py-1 ${tab === t ? "bg-surface-2 font-medium text-fg" : "text-fg-3 hover:text-fg"} ${t === "global" ? "border-l border-line-strong" : ""}`}>{label}</button>
        ))}
      </div>
      {/* This device's own things (live updates, usage, notifications, remote access): global only, so on the global page. */}
      {tools && tab === "global" && <div className="mt-6">{tools}</div>}
      <div className="mt-6">
        {tab === "global" ? <GlobalSettingsPage key="global" onChanged={onChanged} server={server} />
          : info ? <ProjectSettingsPage key={`${project.id}:${info.own.join(",")}`} project={project} info={info} onChanged={onChanged} />
          : <p className="text-sm text-fg-3">Loading…</p>}
      </div>
    </div>
  );
}

/**
 * A project's settings: the project-only ones, and for each setting with a global value a switch between following
 * the global value (shown greyed, marked "global") and its own.
 */
function ProjectSettingsPage({ project, info, onChanged }: { project: ProjectFile; info: ProjectSettingsInfo; onChanged: () => void }) {
  const global = valuesOf(info.global);
  const effective = valuesOf(project);
  // A following setting shows the global value (also where the project has no section for it yet: its orchestrator).
  const v = useValues(Object.fromEntries(SETTING_KEYS.map((k) => [k, info.own.includes(k) ? effective[k] : global[k]])));
  const [own, setOwn] = useState<Set<string>>(() => new Set(info.own));
  const [local, setLocal] = useState({
    name: project.name, tools: project.runtimes.claude.allowed_tools.join("\n"),
    notesDir: project.conversations.notes_dir ?? "", worktrees: project.defaults.worktree_dir ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const form: Form = {
    get: v.get, bool: v.bool, set: v.set,
    follows: (keys) => keys.every((k) => !own.has(k)),
    toggle: (keys, makeOwn) => {
      setOwn((x) => { const n = new Set(x); for (const k of keys) { if (makeOwn) n.add(k); else n.delete(k); } return n; });
      // Following again shows the global value; becoming its own starts from it.
      if (!makeOwn) v.setValues((x) => ({ ...x, ...Object.fromEntries(keys.map((k) => [k, global[k]])) }));
    },
  };
  const save = async () => {
    setBusy(true); setMsg(undefined);
    try {
      const mine = SETTING_KEYS.filter((k) => own.has(k));
      const body = nested(v.values, mine) as { defaults?: Values; runtimes?: { claude?: Values } & Values; conversations?: Values };
      body.defaults = { ...body.defaults, worktree_dir: local.worktrees || null };
      body.runtimes = { ...body.runtimes, claude: { ...body.runtimes?.claude, allowed_tools: local.tools.split(/\n|,/).map((x) => x.trim()).filter(Boolean) } };
      body.conversations = { ...body.conversations, notes_dir: local.notesDir || null };
      await act(project.id, "PATCH", "/settings", { ...body, name: local.name, own: mine, follow: SETTING_KEYS.filter((k) => !own.has(k)) });
      setMsg({ ok: true, text: "Saved. Runs pick the new settings up at their next step; the orchestrator and thinking partners at their next message." });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const p = { values: local, set: (k: string, x: string) => setLocal((y) => ({ ...y, [k]: x })), root: project.root };
  return (
    <>
      <p className="text-xs text-fg-3">
        A setting marked <span className="rounded bg-surface-2 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide">global</span> follows
        the global value, shown greyed; switch it to Own to give this project its own. The rest belong to this project only.
      </p>
      <div className="mt-4"><SettingRows form={form} project={p} /></div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
      </div>
    </>
  );
}

/** The global settings, which every project follows where it has no value of its own, and the global-only ones. */
function GlobalSettingsPage({ onChanged, server }: { onChanged: () => void; server?: ServerInfo }) {
  const [version, setVersion] = useState(0);
  const data = useFetch<{ global: GlobalSettings }>("/api/settings", version);
  if (!data) return <p className="text-sm text-fg-3">Loading…</p>;
  return <GlobalForm key={version} global={data.global} server={server} onSaved={() => { setVersion((x) => x + 1); onChanged(); }} onChanged={onChanged} />;
}

function GlobalForm({ global, server, onSaved, onChanged }: { global: GlobalSettings; server?: ServerInfo; onSaved: () => void; onChanged: () => void }) {
  const v = useValues(valuesOf(global));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const save = async () => {
    setBusy(true); setMsg(undefined);
    try {
      await request("/api/settings", "PATCH", nested(v.values, SETTING_KEYS));
      setMsg({ ok: true, text: "Saved. Every project that follows a changed value has it now; running sessions at their next step or message." });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <>
      <SettingRows form={{ get: v.get, bool: v.bool, set: v.set }} />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
      </div>
      <BrowserSection />
      <ServerSection info={server} onChanged={onChanged} />
    </>
  );
}

/** A write outside a project (the global settings): JSON, from this page. */
async function request(path: string, method: string, body: unknown): Promise<unknown> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data;
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

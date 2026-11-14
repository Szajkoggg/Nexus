// Settings: the global ones every project follows, and a project's own (how its agents run, its defaults), each
// setting with a global value switched between following it and the project's own value (PROTOCOL.md, "Global settings").
import { useState, type ReactNode } from "react";
import type { GlobalSettings, ProjectFile } from "@nexus/protocol";
import { LANGUAGES } from "@nexus/protocol/languages";
import { act, useFetch } from "../api.ts";
import { Button, Section } from "./ui.tsx";
import { rich, t, type Key } from "../i18n.ts";
import { CHOICES, readChoice, setChoice, type ThemeChoice } from "../theme.ts";
import { EDITOR_CHOICES, readEditor, setEditor, type Editor } from "../editor.ts";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The offered languages as choices: the English name, and the language's own name where it differs. */
const LANGUAGE_CHOICES: [string, string][] = LANGUAGES.map((l) => [l.code, l.native === l.name ? l.name : `${l.name} (${l.native})`]);

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
    <button onClick={onClick} title={t("sidebar.projectSettings")} className="rounded-md p-1.5 text-fg-3 hover:bg-surface hover:text-fg">
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
  "defaults.stop_conditions", "defaults.review_level", "defaults.review_send_back_limit", "defaults.context_reuse_threshold",
  "defaults.context_care", "defaults.protect_nexus", "defaults.push_accepted", "defaults.usage_pause_threshold",
  "runtimes.default", "runtimes.claude.model", "runtimes.claude.effort", "runtimes.claude.permission_mode",
  "runtimes.codex.model", "runtimes.codex.effort", "runtimes.codex.sandbox", "runtimes.codex.approval_policy", "runtimes.codex.approvals_reviewer",
  "conversations.runtime", "conversations.model", "conversations.effort",
  "orchestrator.runtime", "orchestrator.model", "orchestrator.effort", "orchestrator.notify",
  "languages.reader",
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
        {follows && <span className="rounded bg-surface-2 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-fg-3" title={t("settings.followsTitle")}>{t("settings.global")}</span>}
      </span>
      <span className="min-w-0">
        <span className="flex items-start gap-2">
          <span className={`min-w-0 flex-1 ${follows ? "opacity-50" : ""}`}>{children(follows)}</span>
          {form.toggle && (
            <span className="inline-flex shrink-0 overflow-hidden rounded-md border border-line-strong text-xs" role="group" aria-label={t("settings.globalOrOwn", { label })}>
              <button type="button" onClick={() => form.toggle!(keys, false)} aria-pressed={follows}
                className={`px-2 py-1 ${follows ? "bg-surface-2 text-fg" : "text-fg-3 hover:text-fg"}`}>{t("settings.globalButton")}</button>
              <button type="button" onClick={() => form.toggle!(keys, true)} aria-pressed={!follows}
                className={`border-l border-line-strong px-2 py-1 ${!follows ? "bg-accent/15 text-fg" : "text-fg-3 hover:text-fg"}`}>{t("settings.own")}</button>
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
      <Section title={t("settings.general")}>
        {p && <Row label={t("settings.name")}><input value={p.values.name} onChange={(e) => p.set("name", e.target.value)} className={field} /></Row>}
        <Setting form={f} keys={["runtimes.default"]} label={t("settings.defaultRuntime")} hint={t("settings.defaultRuntimeHint")}>
          {(d) => <Select value={f.get("runtimes.default")} onChange={(v) => f.set("runtimes.default", v)} disabled={d} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />}
        </Setting>
      </Section>

      <Section title={t("settings.languages")}>
        <Setting form={f} keys={["languages.reader"]} label={t("settings.readerLanguage")} hint={t("settings.readerLanguageHint")}>
          {(d) => <Select value={f.get("languages.reader")} onChange={(v) => f.set("languages.reader", v)} disabled={d} empty={t("settings.readerLanguageEmpty")} options={LANGUAGE_CHOICES} />}
        </Setting>
        {p && (
          <Row label={t("settings.workingLanguage")} hint={t("settings.workingLanguageHint")}>
            <Select value={p.values.working ?? "en"} onChange={(v) => p.set("working", v)} options={LANGUAGE_CHOICES} />
          </Row>
        )}
      </Section>

      <Section title={t("settings.claudeWorkers")}>
        <Setting form={f} keys={["runtimes.claude.model"]} label={t("settings.model")}>
          {(d) => <ModelSelect runtime="claude" value={claudeModel} onChange={(v) => f.set("runtimes.claude.model", v)} disabled={d} defaultLabel={t("settings.claudeDefault")} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.claude.effort"]} label={t("settings.effort")}>
          {(d) => <EffortSelect runtime="claude" model={claudeModel} value={f.get("runtimes.claude.effort")} onChange={(v) => f.set("runtimes.claude.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.claude.permission_mode"]} label={t("settings.permissions")} hint={t(claudeAuto ? "settings.permissionsAutoHint" : "settings.permissionsHint")}>
          {(d) => <Select value={f.get("runtimes.claude.permission_mode")} onChange={(v) => f.set("runtimes.claude.permission_mode", v)} disabled={d} options={[
            ["auto", t("settings.mode.auto")], ["acceptEdits", t("settings.mode.acceptEdits")],
            ["dontAsk", t("settings.mode.dontAsk")], ["bypassPermissions", t("settings.mode.bypass")], ["plan", t("settings.mode.plan")],
          ]} />}
        </Setting>
        {p && (
          <Row label={t("settings.alsoAllowed")} hint={t("settings.alsoAllowedHint")}>
            <textarea value={p.values.tools} onChange={(e) => p.set("tools", e.target.value)} rows={3} className={`${field} font-mono text-xs`} />
          </Row>
        )}
        <Setting form={f} keys={["defaults.protect_nexus"]} label={t("settings.protect")} hint={t("settings.protectHint")}>
          {(d) => <Check checked={f.bool("defaults.protect_nexus")} onChange={(v) => f.set("defaults.protect_nexus", v)} disabled={d}>{t("settings.protectCheck")}</Check>}
        </Setting>
      </Section>

      <Section title={t("settings.codexWorkers")}>
        <Setting form={f} keys={["runtimes.codex.model"]} label={t("settings.model")}>
          {(d) => <ModelSelect runtime="codex" value={codexModel} onChange={(v) => f.set("runtimes.codex.model", v)} disabled={d} defaultLabel={t("settings.codexDefault")} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.codex.effort"]} label={t("settings.effort")}>
          {(d) => <EffortSelect runtime="codex" model={codexModel} value={f.get("runtimes.codex.effort")} onChange={(v) => f.set("runtimes.codex.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["runtimes.codex.sandbox"]} label={t("settings.sandbox")}>
          {(d) => <Select value={f.get("runtimes.codex.sandbox")} onChange={(v) => f.set("runtimes.codex.sandbox", v)} disabled={d} options={[["workspace-write", t("settings.sandbox.workspace")], ["read-only", "read-only"], ["danger-full-access", t("settings.sandbox.full")]]} />}
        </Setting>
        <Setting form={f} keys={["runtimes.codex.approval_policy", "runtimes.codex.approvals_reviewer"]} label={t("settings.leaving")} hint={t(codexAuto ? "settings.leaving.autoHint" : approval === "never" ? "settings.leaving.neverHint" : "settings.leaving.requestHint")}>
          {(d) => <Select value={codexAuto ? "auto" : approval} disabled={d} onChange={(v) => {
            if (v === "auto") { f.set("runtimes.codex.approval_policy", "on-request"); f.set("runtimes.codex.approvals_reviewer", "auto_review"); }
            else { f.set("runtimes.codex.approval_policy", v); f.set("runtimes.codex.approvals_reviewer", ""); }
          }} options={[["auto", t("settings.leaving.auto")], ["never", t("settings.leaving.never")], ["on-request", t("settings.leaving.request")]]} />}
        </Setting>
      </Section>

      <Section title={t("settings.orchestrator")}>
        <Setting form={f} keys={["orchestrator.model"]} label={t("settings.model")} hint={t("settings.orchestratorModelHint")}>
          {(d) => <ModelSelect runtime="claude" value={f.get("orchestrator.model")} onChange={(v) => f.set("orchestrator.model", v)} disabled={d} defaultLabel={t("settings.claudeDefault")} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["orchestrator.effort"]} label={t("settings.effort")}>
          {(d) => <EffortSelect runtime="claude" model={f.get("orchestrator.model")} value={f.get("orchestrator.effort")} onChange={(v) => f.set("orchestrator.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["orchestrator.notify"]} label={t("settings.tellIt")}>
          {(d) => <Check checked={f.bool("orchestrator.notify")} onChange={(v) => f.set("orchestrator.notify", v)} disabled={d}>{t("settings.tellItCheck")}</Check>}
        </Setting>
      </Section>

      <Section title={t("settings.ideas")}>
        {p && (
          <Row label={t("settings.notesFolder")} hint={t("settings.notesFolderHint")}>
            <input value={p.values.notesDir} onChange={(e) => p.set("notesDir", e.target.value)} placeholder={t("settings.readOnly")} className={`${field} font-mono text-xs`} />
          </Row>
        )}
        <Setting form={f} keys={["conversations.runtime"]} label={t("settings.runtime")}>
          {(d) => <Select value={ideasRuntime} disabled={d} onChange={(v) => { f.set("conversations.runtime", v); f.set("conversations.model", ""); f.set("conversations.effort", ""); }} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />}
        </Setting>
        <Setting form={f} keys={["conversations.model"]} label={t("settings.model")}>
          {(d) => <ModelSelect runtime={ideasRuntime} value={f.get("conversations.model")} onChange={(v) => f.set("conversations.model", v)} disabled={d} defaultLabel={t("settings.runtimeDefault")} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["conversations.effort"]} label={t("settings.effort")}>
          {(d) => <EffortSelect runtime={ideasRuntime} model={f.get("conversations.model")} value={f.get("conversations.effort")} onChange={(v) => f.set("conversations.effort", v)} disabled={d} className="w-full" />}
        </Setting>
      </Section>

      <Section title={t("settings.defaults")}>
        <Setting form={f} keys={["defaults.review_level"]} label={t("details.level.label")} hint={f.get("defaults.review_level") !== "1" ? t("settings.levelHint") : undefined}>
          {(d) => <Select value={f.get("defaults.review_level")} onChange={(v) => f.set("defaults.review_level", Number(v))} disabled={d} options={[["1", t("details.level.1")], ["2", t("details.level.2")], ["3", t("details.level.3")]]} />}
        </Setting>
        <Setting form={f} keys={["defaults.push_accepted"]} label={t("settings.push")} hint={t("settings.pushHint")}>
          {(d) => <Check checked={f.bool("defaults.push_accepted")} onChange={(v) => f.set("defaults.push_accepted", v)} disabled={d}>{t("settings.pushCheck")}</Check>}
        </Setting>
        <Setting form={f} keys={["defaults.usage_pause_threshold"]} label={t("settings.pauseAt")} hint={t("settings.pauseAtHint")}>
          {(d) => <Percent value={f.get("defaults.usage_pause_threshold")} onChange={(v) => f.set("defaults.usage_pause_threshold", v)} disabled={d} />}
        </Setting>
        <Setting form={f} keys={["defaults.context_reuse_threshold"]} label={t("settings.reuse")} hint={t("settings.reuseHint")}>
          {(d) => <Percent value={f.get("defaults.context_reuse_threshold")} onChange={(v) => f.set("defaults.context_reuse_threshold", v)} disabled={d} />}
        </Setting>
        <Setting form={f} keys={["defaults.context_care"]} label={t("settings.care")} hint={t("settings.careHint")}>
          {(d) => <Check checked={f.bool("defaults.context_care")} onChange={(v) => f.set("defaults.context_care", v)} disabled={d}>{t("settings.careCheck")}</Check>}
        </Setting>
        {p && (
          <Row label={t("settings.worktreesIn")} hint={t("settings.worktreesInHint")}>
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
      <div className="break-all pr-8 text-xs text-fg-3">{tab === "project" ? project.root : t("settings.globalNote")}</div>
      <h2 className="mt-1 pr-8 text-xl font-semibold text-fg">{t(tab === "project" ? "settings.projectTitle" : "settings.globalTitle")}</h2>
      <div className="mt-3 inline-flex overflow-hidden rounded-md border border-line-strong text-sm" role="tablist">
        {([["project", project.name], ["global", t("settings.globalButton")]] as const).map(([x, label]) => (
          <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)}
            className={`px-3 py-1 ${tab === x ? "bg-surface-2 font-medium text-fg" : "text-fg-3 hover:text-fg"} ${x === "global" ? "border-l border-line-strong" : ""}`}>{label}</button>
        ))}
      </div>
      {/* This device's own things (live updates, usage, notifications, remote access): global only, so on the global page. */}
      {tools && tab === "global" && <div className="mt-6">{tools}</div>}
      <div className="mt-6">
        {tab === "global" ? <GlobalSettingsPage key="global" onChanged={onChanged} server={server} />
          : info ? <ProjectSettingsPage key={`${project.id}:${info.own.join(",")}`} project={project} info={info} onChanged={onChanged} />
          : <p className="text-sm text-fg-3">{t("common.loading")}</p>}
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
    working: project.languages?.working ?? "en",
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
      const body = nested(v.values, mine) as { defaults?: Values; runtimes?: { claude?: Values } & Values; conversations?: Values; languages?: Values };
      body.defaults = { ...body.defaults, worktree_dir: local.worktrees || null };
      body.runtimes = { ...body.runtimes, claude: { ...body.runtimes?.claude, allowed_tools: local.tools.split(/\n|,/).map((x) => x.trim()).filter(Boolean) } };
      body.conversations = { ...body.conversations, notes_dir: local.notesDir || null };
      body.languages = { ...body.languages, working: local.working };
      await act(project.id, "PATCH", "/settings", { ...body, name: local.name, own: mine, follow: SETTING_KEYS.filter((k) => !own.has(k)) });
      setMsg({ ok: true, text: t("settings.savedProject") });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const p = { values: local, set: (k: string, x: string) => setLocal((y) => ({ ...y, [k]: x })), root: project.root };
  return (
    <>
      <p className="text-xs text-fg-3">
        {rich("settings.projectNote", { global: <span key="global" className="rounded bg-surface-2 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide">{t("settings.global")}</span> })}
      </p>
      <div className="mt-4"><SettingRows form={form} project={p} /></div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>{t(busy ? "settings.saving" : "settings.save")}</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
      </div>
    </>
  );
}

/** The global settings, which every project follows where it has no value of its own, and the global-only ones. */
function GlobalSettingsPage({ onChanged, server }: { onChanged: () => void; server?: ServerInfo }) {
  const [version, setVersion] = useState(0);
  const data = useFetch<{ global: GlobalSettings }>("/api/settings", version);
  if (!data) return <p className="text-sm text-fg-3">{t("common.loading")}</p>;
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
      setMsg({ ok: true, text: t("settings.savedGlobal") });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <>
      <SettingRows form={{ get: v.get, bool: v.bool, set: v.set }} />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>{t(busy ? "settings.saving" : "settings.save")}</Button>
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

/** What this browser keeps for itself, for every project: the theme and the editor. Applies at once; nothing to save. */
function BrowserSection() {
  const [choice, setLocal] = useState<ThemeChoice>(readChoice);
  const [editor, setEditorLocal] = useState<Editor>(readEditor);
  return (
    <Section title={t("settings.browser")}>
      <Row label={t("settings.theme")} hint={t("settings.themeHint")}>
        <Select value={choice} onChange={(v) => { setChoice(v as ThemeChoice); setLocal(v as ThemeChoice); }}
          options={CHOICES.map((c) => [c.value, t(c.label)] as [string, string])} />
      </Row>
      <Row label={t("settings.editor")} hint={t("settings.editorHint")}>
        <Select value={editor} onChange={(v) => { setEditor(v as Editor); setEditorLocal(v as Editor); }}
          options={EDITOR_CHOICES.map((c) => [c.value, t(c.label)] as [string, string])} />
      </Row>
    </Section>
  );
}

// ---------------------------------------------------------------- Nexus itself

export interface ServerInfo {
  commit: string; subject: string; live: boolean; branch: string | null; root: string;
  /** Whether this page was opened on the server machine (not relayed from another device). */
  local?: boolean;
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
const PUSH_LABEL: Record<"pushed" | "failed" | "skipped", Key> = { pushed: "settings.server.pushed", failed: "settings.server.pushFailed", skipped: "settings.server.notPushed" };

export function useServer(version: unknown) {
  return useFetch<ServerInfo>("/api/server", version);
}

/** A pill in the header while Nexus updates itself. */
export function UpdatePill({ info }: { info: ServerInfo | undefined }) {
  const u = info?.update;
  if (!u || u.phase === "idle" || u.phase === "updated") return null;
  const text = u.phase === "draining" ? (u.waiting.length ? t("update.waitingFor", { count: u.waiting.length }) : t("update.updating"))
    : u.phase === "failed" ? t("update.failed") : u.phase;
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
        {info.live ? t("settings.server.live") : t("settings.server.dev", { branch: info.branch ?? "" })} · <span className="font-mono">{info.root}</span>
      </p>
      {u.phase !== "idle" && (
        <div className="mt-3 rounded-lg bg-canvas p-3 text-xs text-fg-2">
          <div className="mb-1 text-fg">{u.phase === "updated" ? rich("settings.server.updated", { commit: <span key="commit" className="font-mono">{info.commit}</span> }) : t("settings.server.update", { phase: u.phase })}{busy && u.held.length ? `; ${t("settings.server.holding", { queues: u.held.join(", ") })}` : ""}{u.waiting.length ? `; ${t("settings.server.waitingFor", { projects: u.waiting.join(", ") })}` : ""}</div>
          {u.push && <div className={`mb-1 ${PUSH_TONE[u.push.result]}`}><span className="font-semibold">{t(PUSH_LABEL[u.push.result])}:</span> {u.push.text}</div>}
          {u.log.map((l, i) => <div key={i} className="font-mono">{l}</div>)}
          {u.error && <div className="mt-1 whitespace-pre-wrap text-danger">{u.error}</div>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!busy && <Button onClick={() => void call("/api/server/update")}>{t("settings.server.updateButton")}</Button>}
        {!busy && <Button variant="quiet" onClick={() => { if (confirm(t("settings.server.nowConfirm"))) void call("/api/server/update", { now: true }); }}>{t("settings.server.now")}</Button>}
        {u.phase === "draining" && <Button variant="quiet" onClick={() => void call("/api/server/cancel")}>{t("common.cancel")}</Button>}
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm text-fg">
        <input type="checkbox" className="mt-0.5 accent-accent" checked={info.push_on_deploy}
          onChange={(e) => void call("/api/server/settings", { push_on_deploy: e.target.checked })} />
        <span>{t(info.live ? "settings.server.pushDeploy" : "settings.server.pushDeployDev")}</span>
      </label>
      {info.max_running !== undefined && (
        <div className="mt-3 text-sm text-fg">
          <label className="flex flex-wrap items-center gap-2">
            <span>{t("settings.server.maxRunning")}</span>
            <select className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg" value={info.max_running}
              onChange={(e) => void call("/api/server/settings", { max_running: Number(e.target.value) })}>
              {[...new Set([...Array.from({ length: 10 }, (_, i) => i + 1), info.max_running])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <p className="mt-1 text-xs text-fg-3">
            {t("settings.server.maxRunningHint")}
          </p>
        </div>
      )}
      <p className="mt-2 text-xs text-fg-3">
        {t("settings.server.updateHint")}
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
export function ModelSelect({ runtime, value, onChange, defaultLabel = t("run.default"), className = "", disabled }: {
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
        <input autoFocus value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={t("settings.model.full")} className={style} />
        <button type="button" onClick={() => setTyping(false)} className="px-1 text-xs text-fg-2 hover:text-fg" title={t("settings.model.backToList")}>{t("settings.model.list")}</button>
      </span>
    );
  }
  return (
    <select value={value} disabled={disabled} className={style}
      onChange={(e) => { if (e.target.value === "\u0000other") { setTyping(true); onChange(""); } else onChange(e.target.value); }}>
      <option value="">{defaultLabel}</option>
      {options.map(([v, l, d]) => <option key={v} value={v} title={d}>{l}{d ? ` · ${d}` : ""}</option>)}
      {!models && <option disabled value={"\u0000loading"}>{t("settings.model.loading")}</option>}
      <option value={"\u0000other"}>{t("settings.model.other")}</option>
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

export function EffortSelect({ runtime, model, value, onChange, defaultLabel = t("run.default"), className = "", disabled }: {
  runtime: "claude" | "codex"; model: string; value: string; onChange: (v: string) => void; defaultLabel?: string; className?: string; disabled?: boolean;
}) {
  const efforts = useEfforts(runtime, model);
  const options = value && !efforts.includes(value) ? [...efforts, value] : efforts;
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-50 ${className}`}>
      <option value="">{defaultLabel}</option>
      {options.map((x) => <option key={x} value={x}>{efforts.includes(x) ? x : t("settings.effort.notOffered", { effort: x })}</option>)}
    </select>
  );
}

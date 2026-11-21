// Settings: the global ones every project follows, and a project's own (how its agents run, its defaults), each
// setting with a global value switched between following it and the project's own value (docs/protocol/settings.md, "Global settings").
import { useState, type ReactNode } from "react";
import type { GlobalSettings, ProjectFile, TagsFile } from "@nexus/protocol";
import type { ModelInfo } from "@nexus/protocol/api";
import { LANGUAGES } from "@nexus/protocol/languages";
import { TAG_KINDS } from "@nexus/protocol/tags";
import { fallbackLine, parseFallback } from "../fallback.ts";
import { act, HttpError, projectUrl, request, useQuery, type Version } from "../api.ts";
import { Button, ReadError, Section } from "./ui.tsx";
import { rich, t, type Key } from "../i18n.ts";
import { CHOICES, readChoice, setChoice, type ThemeChoice } from "../theme.ts";
import { EDITOR_CHOICES, readEditor, setEditor, type Editor } from "../editor.ts";
import { levelTitle } from "./Levels.tsx";
import { ProjectTags } from "./Tags.tsx";
import { DangerZone } from "./DangerZone.tsx";
import { PlannedDeployCard, type PlannedDeploy } from "./DeployPlan.tsx";
import { FIX_LIMIT, SEND_BACKS, STOPS, conditionList, savedConditions, settingsProblem, type SettingsProblem } from "../settingsCheck.ts";
import { usePage } from "../page.ts";
import { NotifySettingsRows } from "./NotifySettings.tsx";

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
/** A kind's fallback chain: edited as one line of text (fallback.ts). */
const isChain = (k: string) => k.startsWith("kinds.") && k.endsWith(".fallback");
/** A list edited as text: its entries, trimmed, without empty ones. */
const entries = (text: string, separator: string | RegExp = "\n") => text.split(separator).map((x) => x.trim()).filter(Boolean);
/** The settings that are global with a project override, by key, from a project's (effective) or the global settings. */
const valuesOf = (o: unknown): Values => Object.fromEntries(SETTING_KEYS.map((k) => [k,
  k === "orchestrator.fallback" ? JSON.stringify(at(o, k) ?? null) : isChain(k) ? fallbackLine(at(o, k) as never) : at(o, k),
]));
/**
 * Nested settings from keys and values, for a write: an empty optional value is sent as null (none); a fallback
 * chain's line is read back into the list (an entry it cannot read stops the save with its text).
 */
function nested(values: Values, keys: readonly string[]): Values {
  const out: Values = {};
  for (const k of keys) {
    const path = k.split(".");
    let x = out;
    for (const p of path.slice(0, -1)) x = (x[p] ??= {}) as Values;
    const v = values[k];
    if (k === "orchestrator.fallback") { x.fallback = JSON.parse(typeof v === "string" && v ? v : "null"); continue; }
    if (isChain(k)) {
      const r = parseFallback(typeof v === "string" ? v : "");
      if ("bad" in r) throw new Error(t("settings.fallback.bad", { entry: r.bad, kind: path[1]! }));
      x[path.at(-1)!] = r.chain;
      continue;
    }
    if (k === STOPS) { x[path.at(-1)!] = savedConditions(v); continue; }
    x[path.at(-1)!] = v === "" || v === undefined ? null : v;
  }
  return out;
}

/** The hint under the partners' web level: what each level lets them do, and for `fetch` its risk. */
const WEB_HINT: Record<string, Key> = { off: "settings.web.offHint", search: "settings.web.searchHint", fetch: "settings.web.fetchHint" };

/** Every setting with a global value, in the order of docs/protocol/settings.md's list. */
const SETTING_KEYS = [
  "defaults.stop_conditions", "defaults.review_level", "defaults.review_send_back_limit", "defaults.context_reuse_tokens",
  "defaults.context_care", "defaults.protect_nexus", "defaults.push_accepted", "defaults.provisional_counts", "defaults.merge_back", "defaults.resolve_conflicts", "defaults.usage_pause_threshold",
  "defaults.max_running", "defaults.check_fix_limit",
  "runtimes.default", "runtimes.claude.model", "runtimes.claude.effort", "runtimes.claude.permission_mode",
  "runtimes.codex.model", "runtimes.codex.effort", "runtimes.codex.sandbox", "runtimes.codex.approval_policy", "runtimes.codex.approvals_reviewer",
  "conversations.runtime", "conversations.model", "conversations.effort", "conversations.web",
  "orchestrator.runtime", "orchestrator.model", "orchestrator.effort", "orchestrator.fallback", "orchestrator.notify", "orchestrator.context_threshold_tokens",
  "languages.reader",
  ...TAG_KINDS.flatMap((k) => [`kinds.${k}.runtime`, `kinds.${k}.model`, `kinds.${k}.effort`, `kinds.${k}.fallback`]),
  "review_helper.enabled", "review_helper.runtime", "review_helper.model", "review_helper.effort", "review_helper.audit_rate",
];

/**
 * The limit on queues running at once. Its global value is changed in the Nexus section (POST /api/server/settings),
 * so the global form neither shows nor saves it (a save would put back the value it was opened with); a project's
 * page has its own value of it, beside the global one (both hold).
 */
const MAX_RUNNING = "defaults.max_running";
/** The settings the global form saves. */
const GLOBAL_FORM_KEYS = SETTING_KEYS.filter((k) => k !== MAX_RUNNING);
/** The limits offered: 1 to 10, and a value set otherwise (up to 20). */
const limitChoices = (current: string) => [...new Set([...Array.from({ length: 10 }, (_, i) => i + 1), Number(current) || 1])].sort((a, b) => a - b).map(String);

/**
 * What a row needs: the value of a setting, its change, and on a project's page whether it follows the global value
 * (then its control shows the global value, greyed, and cannot be changed until the row is switched to its own).
 */
interface Form {
  get: (k: string) => string;
  bool: (k: string) => boolean;
  /** A list setting's entries (the stop conditions). */
  list: (k: string) => string[];
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
  // The orchestrator runs on Codex only when its setting says codex; anything else is Claude Code (as the server reads it).
  const orchRuntime: "claude" | "codex" = f.get("orchestrator.runtime") === "codex" ? "codex" : "claude";
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
        {p && (
          <Row label={t("settings.codexMcp")} hint={<>{t("settings.codexMcpHint")} <span className="text-warn">{t("settings.codexMcpWarning")}</span></>}>
            <textarea value={p.values.mcp} onChange={(e) => p.set("mcp", e.target.value)} rows={2} placeholder={t("settings.codexMcpEmpty")} className={`${field} font-mono text-xs`} />
          </Row>
        )}
      </Section>

      <Section title={t("settings.kinds")}>
        <p className="pb-1 text-xs text-fg-3">{t("settings.kindsNote")}</p>
        {TAG_KINDS.map((k) => <KindRow key={k} form={f} kind={k} />)}
      </Section>

      <Section title={t("settings.orchestrator")}>
        {/* Its runtime (queue OC): another one starts a fresh orchestrator session; the model and effort go by it. */}
        <Setting form={f} keys={["orchestrator.runtime"]} label={t("settings.runtime")}
          hint={orchRuntime === "codex" ? <span className="text-warn">{t("settings.orchestratorCodexHint")}</span> : t("settings.orchestratorClaudeHint")}>
          {(d) => <Select value={orchRuntime} disabled={d} onChange={(v) => { f.set("orchestrator.runtime", v); f.set("orchestrator.model", ""); f.set("orchestrator.effort", ""); }} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />}
        </Setting>
        <Setting form={f} keys={["orchestrator.model"]} label={t("settings.model")} hint={t("settings.orchestratorModelHint")}>
          {(d) => <ModelSelect runtime={orchRuntime} value={f.get("orchestrator.model")} onChange={(v) => f.set("orchestrator.model", v)} disabled={d} defaultLabel={t("settings.runtimeDefault")} className="w-full" />}
        </Setting>
        <Setting form={f} keys={["orchestrator.effort"]} label={t("settings.effort")}>
          {(d) => <EffortSelect runtime={orchRuntime} model={f.get("orchestrator.model")} value={f.get("orchestrator.effort")} onChange={(v) => f.set("orchestrator.effort", v)} disabled={d} className="w-full" />}
        </Setting>
        <OrchestratorFallback form={f} />
        <Setting form={f} keys={["orchestrator.notify"]} label={t("settings.tellIt")}>
          {(d) => <Check checked={f.bool("orchestrator.notify")} onChange={(v) => f.set("orchestrator.notify", v)} disabled={d}>{t("settings.tellItCheck")}</Check>}
        </Setting>
        <Setting form={f} keys={["orchestrator.context_threshold_tokens"]} label={t("settings.orchestratorFresh")} hint={<>{t("settings.orchestratorFreshHint")} {t("settings.tokensCap")}</>}>
          {(d) => <Tokens value={f.get("orchestrator.context_threshold_tokens")} onChange={(v) => f.set("orchestrator.context_threshold_tokens", v)} disabled={d} />}
        </Setting>
      </Section>

      <ReviewHelperRows form={f} />

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
        <Setting form={f} keys={["conversations.web"]} label={t("settings.web")} hint={t(WEB_HINT[f.get("conversations.web")] ?? "settings.web.searchHint")}>
          {(d) => <Select value={f.get("conversations.web")} onChange={(v) => f.set("conversations.web", v)} disabled={d}
            options={[["off", t("settings.web.off")], ["search", t("settings.web.search")], ["fetch", t("settings.web.fetch")]]} />}
        </Setting>
      </Section>

      <Section title={t("settings.defaults")}>
        <Setting form={f} keys={["defaults.review_level"]} label={t("details.level.label")} hint={<>{levelTitle(Number(f.get("defaults.review_level")) || 2)}{f.get("defaults.review_level") !== "1" ? ` ${t("settings.levelHint")}` : ""}</>}>
          {(d) => <Select value={f.get("defaults.review_level")} onChange={(v) => f.set("defaults.review_level", Number(v))} disabled={d} options={[["1", t("details.level.1")], ["2", t("details.level.2")], ["3", t("details.level.3")]]} />}
        </Setting>
        <Setting form={f} keys={[SEND_BACKS]} label={t("settings.sendBacks")} hint={t("settings.sendBacksHint")}>
          {(d) => (
            <input type="number" min={0} step={1} disabled={d} value={f.get(SEND_BACKS)} aria-label={t("settings.sendBacks")}
              onChange={(e) => f.set(SEND_BACKS, e.target.value === "" ? "" : Number(e.target.value))} className={`${field} w-24`} />
          )}
        </Setting>
        <Setting form={f} keys={[FIX_LIMIT]} label={t("settings.checkFixLimit")} hint={t("settings.checkFixLimitHint")}>
          {(d) => (
            <input type="number" min={0} step={1} disabled={d} value={f.get(FIX_LIMIT)} aria-label={t("settings.checkFixLimit")}
              onChange={(e) => f.set(FIX_LIMIT, e.target.value === "" ? "" : Number(e.target.value))} className={`${field} w-24`} />
          )}
        </Setting>
        <Setting form={f} keys={[STOPS]} label={t("settings.stops")} hint={t("settings.stopsHint")}>
          {(d) => <ConditionList value={f.list(STOPS)} onChange={(v) => f.set(STOPS, v)} disabled={d} />}
        </Setting>
        <Setting form={f} keys={["defaults.push_accepted"]} label={t("settings.push")} hint={t("settings.pushHint")}>
          {(d) => <Check checked={f.bool("defaults.push_accepted")} onChange={(v) => f.set("defaults.push_accepted", v)} disabled={d}>{t("settings.pushCheck")}</Check>}
        </Setting>
        <Setting form={f} keys={["defaults.provisional_counts"]} label={t("settings.provisional")} hint={t("settings.provisionalHint")}>
          {(d) => <Check checked={f.bool("defaults.provisional_counts")} onChange={(v) => f.set("defaults.provisional_counts", v)} disabled={d}>{t("settings.provisionalCheck")}</Check>}
        </Setting>
        <Setting form={f} keys={["defaults.usage_pause_threshold"]} label={t("settings.pauseAt")} hint={t("settings.pauseAtHint")}>
          {(d) => <Percent value={f.get("defaults.usage_pause_threshold")} onChange={(v) => f.set("defaults.usage_pause_threshold", v)} disabled={d} />}
        </Setting>
        {p && (
          <Setting form={f} keys={[MAX_RUNNING]} label={t("settings.maxRunning")} hint={t("settings.maxRunningHint")}>
            {(d) => <span className="block w-24"><Select value={f.get(MAX_RUNNING)} onChange={(v) => f.set(MAX_RUNNING, Number(v))} disabled={d} options={limitChoices(f.get(MAX_RUNNING))} /></span>}
          </Setting>
        )}
        <Setting form={f} keys={["defaults.context_reuse_tokens"]} label={t("settings.reuse")} hint={<>{t("settings.reuseHint")} {t("settings.tokensCap")}</>}>
          {(d) => <Tokens value={f.get("defaults.context_reuse_tokens")} onChange={(v) => f.set("defaults.context_reuse_tokens", v)} disabled={d} />}
        </Setting>
        <Setting form={f} keys={["defaults.context_care"]} label={t("settings.care")} hint={t("settings.careHint")}>
          {(d) => <Check checked={f.bool("defaults.context_care")} onChange={(v) => f.set("defaults.context_care", v)} disabled={d}>{t("settings.careCheck")}</Check>}
        </Setting>
        {p && (
          <Row label={t("settings.worktreesIn")} hint={t("settings.worktreesInHint")}>
            <input value={p.values.worktrees} onChange={(e) => p.set("worktrees", e.target.value)} placeholder={`${p.root}/../…worktrees`} className={`${field} font-mono text-xs`} />
          </Row>
        )}
        {p && (
          <Row label={t("settings.checks")} hint={t("settings.checksHint")}>
            <textarea value={p.values.checks} onChange={(e) => p.set("checks", e.target.value)} rows={3} placeholder={t("settings.checksPlaceholder")} className={`${field} font-mono text-xs`} />
          </Row>
        )}
      </Section>

      <Section title={t("settings.merging")}>
        <p className="pb-1 text-xs text-fg-3">{t("settings.mergingNote")}</p>
        <Setting form={f} keys={["defaults.merge_back"]} label={t("settings.mergeBack")} hint={t("settings.mergeBackHint")}>
          {(d) => <Check checked={f.bool("defaults.merge_back")} onChange={(v) => f.set("defaults.merge_back", v)} disabled={d}>{t("settings.mergeBackCheck")}</Check>}
        </Setting>
        <Setting form={f} keys={["defaults.resolve_conflicts"]} label={t("settings.resolveConflicts")} hint={t("settings.resolveConflictsHint")}>
          {(d) => <Check checked={f.bool("defaults.resolve_conflicts")} onChange={(v) => f.set("defaults.resolve_conflicts", v)} disabled={d}>{t("settings.resolveConflictsCheck")}</Check>}
        </Setting>
        {p && (
          <Row label={t("settings.worktreeSetup")} hint={t("settings.worktreeSetupHint")}>
            <input value={p.values.worktreeSetup} onChange={(e) => p.set("worktreeSetup", e.target.value)} placeholder={t("settings.worktreeSetupPlaceholder")} className={`${field} font-mono text-xs`} />
          </Row>
        )}
        <div id="settings-merging-end" />
      </Section>
    </>
  );
}

/**
 * The review helper (queue RH): whether it takes the orchestrator's routine reviews, the runtime, model and effort it
 * runs on (one row, global or the project's own together, like a kind's), and the share of its acceptances audited.
 */
function ReviewHelperRows({ form: f }: { form: Form }) {
  const key = (x: string) => `review_helper.${x}`;
  const runtime = (f.get(key("runtime")) || "claude") as "claude" | "codex";
  const model = f.get(key("model"));
  const on = f.bool(key("enabled"));
  return (
    <Section title={t("settings.reviewHelper")}>
      <p className="pb-1 text-xs text-fg-3" id="settings-review-helper">{t("settings.reviewHelperNote")}</p>
      <Setting form={f} keys={[key("enabled")]} label={t("settings.reviewHelperUse")} hint={t(on ? "settings.reviewHelperOnHint" : "settings.reviewHelperOffHint")}>
        {(d) => <Check checked={on} onChange={(v) => f.set(key("enabled"), v)} disabled={d}>{t("settings.reviewHelperCheck")}</Check>}
      </Setting>
      <Setting form={f} keys={["runtime", "model", "effort"].map(key)} label={t("settings.reviewHelperRunsOn")} hint={t("settings.reviewHelperRunsOnHint")}>
        {(d) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <Select value={runtime} disabled={d} onChange={(v) => { f.set(key("runtime"), v); f.set(key("model"), ""); f.set(key("effort"), ""); }} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />
            <ModelSelect runtime={runtime} value={model} onChange={(v) => f.set(key("model"), v)} disabled={d} defaultLabel={t("settings.kindModelDefault")} />
            <EffortSelect runtime={runtime} model={model} value={f.get(key("effort"))} onChange={(v) => f.set(key("effort"), v)} disabled={d} defaultLabel={t("settings.kindEffortDefault")} />
          </span>
        )}
      </Setting>
      <Setting form={f} keys={[key("audit_rate")]} label={t("settings.reviewHelperAudit")} hint={t("settings.reviewHelperAuditHint")}>
        {(d) => <Percent value={f.get(key("audit_rate"))} onChange={(v) => f.set(key("audit_rate"), v)} disabled={d} min={0} />}
      </Setting>
    </Section>
  );
}

/**
 * One kind's defaults: runtime, model and effort on one line, the fallback chain under them. The four go together
 * (global or the project's own).
 */
function KindRow({ form: f, kind }: { form: Form; kind: string }) {
  const key = (x: string) => `kinds.${kind}.${x}`;
  const runtime = (f.get(key("runtime")) || "claude") as "claude" | "codex";
  const model = f.get(key("model"));
  return (
    <Setting form={f} keys={["runtime", "model", "effort", "fallback"].map(key)} label={kind}>
      {(d) => (
        <span className="block space-y-1.5" id={`kind-${kind}`}>
          <span className="flex flex-wrap items-center gap-1.5">
            <Select value={runtime} disabled={d} onChange={(v) => { f.set(key("runtime"), v); f.set(key("model"), ""); f.set(key("effort"), ""); }} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />
            <ModelSelect runtime={runtime} value={model} onChange={(v) => f.set(key("model"), v)} disabled={d} defaultLabel={t("settings.kindModelDefault")} />
            <EffortSelect runtime={runtime} model={model} value={f.get(key("effort"))} onChange={(v) => f.set(key("effort"), v)} disabled={d} defaultLabel={t("settings.kindEffortDefault")} />
          </span>
          <span className="flex items-center gap-2 text-xs text-fg-3">
            <span className="shrink-0">{t("settings.fallback")}</span>
            <input value={f.get(key("fallback"))} disabled={d} onChange={(e) => f.set(key("fallback"), e.target.value)} placeholder={t("settings.fallbackNone")}
              className={`${field} font-mono text-xs`} aria-label={t("settings.fallbackOf", { kind })} />
          </span>
        </span>
      )}
    </Setting>
  );
}

/**
 * The stop conditions every queue gets besides its own: one text box each, removed with ×, one more added with the
 * button. An empty one cannot be saved (settingsCheck.ts).
 */
function ConditionList({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  return (
    <span className="block space-y-1.5">
      {value.length === 0 && <span className="block pt-1 text-sm text-fg-3">{t("settings.stopsNone")}</span>}
      {value.map((c, i) => (
        <span key={i} className="flex items-start gap-1.5">
          <textarea value={c} rows={2} disabled={disabled} placeholder={t("settings.stopPlaceholder")} aria-label={t("settings.stopNumber", { n: i + 1 })}
            aria-invalid={!c.trim()} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
            className={`${c.trim() ? field : field.replace("border-line-strong", "border-danger")} resize-y`} />
          <button type="button" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} title={t("settings.stopRemove", { n: i + 1 })}
            aria-label={t("settings.stopRemove", { n: i + 1 })} className="mt-0.5 rounded-md px-2 py-1 text-fg-3 hover:bg-surface hover:text-fg disabled:hover:bg-transparent">×</button>
        </span>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...value, ""])}
        className="rounded-md border border-line-strong px-2 py-1 text-xs text-fg-2 hover:text-fg disabled:hover:text-fg-2">{t("settings.stopAdd")}</button>
    </span>
  );
}

/** What stops a save, in a sentence for the save row. */
const problemText = (p: SettingsProblem) => (p.kind === "emptyCondition" ? t("settings.problem.emptyCondition", { n: p.n }) : t(p.kind === "badFixLimit" ? "settings.problem.badFixLimit" : "settings.problem.badLimit"));

/**
 * Save, and beside it what stops a save (the button is off then) or how the last one went. The same on the project's
 * page and the global one.
 */
function SaveRow({ busy, problem, msg, onSave }: { busy: boolean; problem?: SettingsProblem; msg?: { ok: boolean; text: string }; onSave: () => void }) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <Button onClick={onSave} disabled={busy || !!problem}>{t(busy ? "settings.saving" : "settings.save")}</Button>
      {problem ? <span className="text-sm text-danger">{problemText(problem)}</span>
        : msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</span>}
    </div>
  );
}

/** A share (0 to 1) shown and typed as a percentage. */
function Percent({ value, onChange, disabled, min = 10 }: { value: string; onChange: (v: number) => void; disabled: boolean; min?: number }) {
  return (
    <span className="flex items-center gap-2">
      <input type="number" min={min} max={100} disabled={disabled} value={Math.round(Number(value) * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} className={`${field} w-24`} /> %
    </span>
  );
}

/** A number of context tokens shown and typed in thousands (300 for 300,000). */
function Tokens({ value, onChange, disabled }: { value: string; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <input type="number" min={1} max={10_000} step={10} disabled={disabled} value={Math.round(Number(value) / 1000)} onChange={(e) => onChange(Number(e.target.value) * 1000)} className={`${field} w-24`} />
      <span className="whitespace-nowrap">{t("settings.kTokens")}</span>
    </span>
  );
}

/** The form's state over the settings with a global value: a key's value as a string for the controls, or a flag. */
function OrchestratorFallback({ form: f }: { form: Form }) {
  const key = "orchestrator.fallback";
  const value = JSON.parse(f.get(key) || "null") as NonNullable<ProjectFile["orchestrator"]>["fallback"] | null;
  const set = (next: typeof value) => f.set(key, JSON.stringify(next));
  return <Setting form={f} keys={[key]} label={t("settings.fallback")} hint={<>
    {t("settings.orchestratorFallbackHint")}
    {value?.runtime === "codex" && <span className="mt-1 block text-warn">{t("settings.orchestratorCodexHint")}</span>}
  </>}>
    {(d) => <span className="grid gap-2">
      <Select value={value?.runtime ?? ""} disabled={d} empty={t("settings.fallbackNone")}
        options={[["claude", "Claude Code"], ["codex", "Codex"]]}
        onChange={(runtime) => set(runtime ? { runtime: runtime as "claude" | "codex" } : null)} />
      {value && <>
        <label className="grid gap-1 text-xs text-fg-3">{t("settings.model")}
          <ModelSelect runtime={value.runtime} value={value.model ?? ""} disabled={d} defaultLabel={t("settings.runtimeDefault")} className="w-full"
            onChange={(model) => set({ ...value, model: model || undefined })} />
        </label>
        <label className="grid gap-1 text-xs text-fg-3">{t("settings.effort")}
          <EffortSelect runtime={value.runtime} model={value.model ?? ""} value={value.effort ?? ""} disabled={d} className="w-full"
            onChange={(effort) => set({ ...value, effort: effort ? effort as NonNullable<typeof value>["effort"] : undefined })} />
        </label>
      </>}
    </span>}
  </Setting>;
}

function useValues(initial: Values) {
  const [values, setValues] = useState<Values>(initial);
  return {
    values, setValues,
    get: (k: string) => (values[k] === undefined || values[k] === null ? "" : String(values[k])),
    bool: (k: string) => values[k] === true,
    list: (k: string) => conditionList(values[k]),
    set: (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v })),
  };
}

export function SettingsPanel({ project, tags, server, tools }: {
  project: ProjectFile; server?: ServerInfo;
  /** The project's tag lists (ProjectState.tags), shown under its settings. */
  tags?: TagsFile;
  /** On the phone, where the header has no icon row: the update, the usage, notifications and remote access. */
  tools?: ReactNode;
}) {
  const { reload: onChanged } = usePage();
  const [tab, setTab] = useState<"project" | "global">("project");
  const { data: info, error: infoError } = useQuery<ProjectSettingsInfo>(projectUrl(project.id, "/settings"), usePage().settings);
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
        {tab === "global" ? <GlobalSettingsPage key="global" server={server} />
          : info ? <ProjectSettingsPage project={project} info={info} />
          : infoError ? <ReadError error={infoError} />
          : <p className="text-sm text-fg-3">{t("common.loading")}</p>}
        {tab === "project" && tags && <div id="project-tags" className="mt-10"><ProjectTags project={project.id} tags={tags} onChanged={onChanged} /></div>}
        {tab === "project" && <div className="mt-10"><DangerZone project={project} /></div>}
      </div>
    </div>
  );
}

/**
 * A project's settings: the project-only ones, and for each setting with a global value a switch between following
 * the global value (shown greyed, marked "global") and its own.
 */
function ProjectSettingsPage({ project, info }: { project: ProjectFile; info: ProjectSettingsInfo; }) {
  const { reloaded } = usePage();
  const global = valuesOf(info.global);
  const effective = valuesOf(project);
  // A following setting shows the global value (also where the project has no section for it yet: its orchestrator).
  const v = useValues(Object.fromEntries(SETTING_KEYS.map((k) => [k, info.own.includes(k) ? effective[k] : global[k]])));
  const [own, setOwn] = useState<Set<string>>(() => new Set(info.own));
  const [local, setLocal] = useState({
    name: project.name, tools: project.runtimes.claude.allowed_tools.join("\n"), mcp: project.runtimes.codex.mcp_servers.join("\n"),
    notesDir: project.conversations.notes_dir ?? "", worktrees: project.defaults.worktree_dir ?? "", worktreeSetup: project.defaults.worktree_setup ?? "",
    checks: project.defaults.checks.join("\n"),
    working: project.languages?.working ?? "en",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const problem = settingsProblem(v.values, SETTING_KEYS.filter((k) => own.has(k)));
  const form: Form = {
    get: v.get, bool: v.bool, list: v.list, set: v.set,
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
      const body = nested(v.values, mine) as { defaults?: Values; runtimes?: { claude?: Values; codex?: Values } & Values; conversations?: Values; languages?: Values };
      body.defaults = { ...body.defaults, worktree_dir: local.worktrees || null, worktree_setup: local.worktreeSetup.trim() || null,
        checks: entries(local.checks) };
      body.runtimes = { ...body.runtimes, claude: { ...body.runtimes?.claude, allowed_tools: entries(local.tools, /\n|,/) },
        codex: { ...body.runtimes?.codex, mcp_servers: entries(local.mcp, /\n|,/) } };
      body.conversations = { ...body.conversations, notes_dir: local.notesDir || null };
      body.languages = { ...body.languages, working: local.working };
      await act(project.id, "PATCH", "/settings", { ...body, name: local.name, own: mine, follow: SETTING_KEYS.filter((k) => !own.has(k)) });
      // Saving until the state after the save shows (page.ts, reloaded). The form keeps what it holds, which is what was
      // saved: built again from reads that land one by one, it would show values from before the save for a moment.
      await reloaded(projectUrl(project.id, "/state"), projectUrl(project.id, "/settings"));
      setMsg({ ok: true, text: t("settings.savedProject") });
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
      <SaveRow busy={busy} problem={problem} msg={msg} onSave={() => void save()} />
    </>
  );
}

/** The global settings, which every project follows where it has no value of its own, and the global-only ones. */
function GlobalSettingsPage({ server }: { server?: ServerInfo }) {
  // Read when the page opens; the form is built once from it and keeps what it holds after a save (what was saved).
  // Built again from a new read, it would show the values from before the save until that read landed.
  const { data, error } = useQuery<{ global: GlobalSettings }>("/api/settings");
  if (!data) return error ? <ReadError error={error} /> : <p className="text-sm text-fg-3">{t("common.loading")}</p>;
  return <GlobalForm global={data.global} server={server} />;
}

function GlobalForm({ global, server }: { global: GlobalSettings; server?: ServerInfo }) {
  const { reloaded } = usePage();
  const v = useValues(valuesOf(global));
  const problem = settingsProblem(v.values, GLOBAL_FORM_KEYS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const save = async () => {
    setBusy(true); setMsg(undefined);
    try {
      await request("/api/settings", { method: "PATCH", body: nested(v.values, GLOBAL_FORM_KEYS) });
      // Saving until the state after the save shows (page.ts, reloaded).
      await reloaded();
      setMsg({ ok: true, text: t("settings.savedGlobal") });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <>
      <SettingRows form={{ get: v.get, bool: v.bool, list: v.list, set: v.set }} />
      <SaveRow busy={busy} problem={problem} msg={msg} onSave={() => void save()} />
      <BrowserSection />
      <ServerSection info={server} />
    </>
  );
}

// ---------------------------------------------------------------- this browser

/**
 * What this browser keeps for itself, for every project: the theme, the editor and which notifications it gets (those
 * with its push subscription, when it has one). Applies at once; nothing to save.
 */
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
      <NotifySettingsRows />
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
  /** How many queues may run at once, across all projects (the global `defaults.max_running`). */
  max_running?: number;
  /** The user's away mode now (docs/protocol/review.md, "Away mode"). */
  away?: { on: boolean; since?: string; until?: string };
  /** The planned deploy, if any (docs/protocol/api.md, "Planned deploys"). */
  plan?: PlannedDeploy | null;
  /** The server's last crash, until the user closes its notice (docs/protocol/api.md, "Server crash"). */
  crash?: ServerCrash | null;
}

/** An uncaught exception that ended the server (src/crash.ts on the server). */
export interface ServerCrash { at: string; error: string }

const PUSH_TONE = { pushed: "text-ok", failed: "text-danger", skipped: "text-fg-2" } as const;
const PUSH_LABEL: Record<"pushed" | "failed" | "skipped", Key> = { pushed: "settings.server.pushed", failed: "settings.server.pushFailed", skipped: "settings.server.notPushed" };

export function useServer(version: Version) {
  return useQuery<ServerInfo>("/api/server", version).data;
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

/** What POST /api/server/settings takes. */
interface ServerSettings { push_on_deploy?: boolean; max_running?: number }

function ServerSection({ info }: { info: ServerInfo | undefined; }) {
  const { reloaded } = usePage();
  const [msg, setMsg] = useState<string>();
  // A server setting's value asked for: shown at once, its control in progress, until the server's state after the
  // write shows (page.ts, reloaded). A controlled control would otherwise snap back to the old value until then.
  const [asked, setAsked] = useState<ServerSettings>();
  if (!info) return null;
  const u = info.update;
  const call = async (path: string, body: unknown = {}) => {
    setMsg(undefined);
    // A refusal is said here; a network failure as before. The server's state is read again either way.
    try { await request(path, { method: "POST", body }); }
    catch (e) { if (e instanceof HttpError) setMsg(e.message); else throw e; }
    finally { await reloaded("/api/server"); }
  };
  const setting = (body: ServerSettings) => { setAsked(body); void call("/api/server/settings", body).finally(() => setAsked(undefined)); };
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
      <div className="mt-3 rounded-lg bg-canvas p-3">
        {info.plan ? <PlannedDeployCard plan={info.plan} framed={false} />
          : <p className="text-xs text-fg-3">{t("settings.server.noPlan")}</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!busy && <Button onClick={() => void call("/api/server/update")}>{t("settings.server.updateButton")}</Button>}
        {!busy && <Button variant="quiet" onClick={() => { if (confirm(t("settings.server.nowConfirm"))) void call("/api/server/update", { now: true }); }}>{t("settings.server.now")}</Button>}
        {u.phase === "draining" && <Button variant="quiet" onClick={() => void call("/api/server/cancel")}>{t("common.cancel")}</Button>}
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm text-fg">
        <input type="checkbox" className="mt-0.5 accent-accent" checked={asked?.push_on_deploy ?? info.push_on_deploy} disabled={!!asked}
          aria-busy={asked?.push_on_deploy !== undefined} onChange={(e) => setting({ push_on_deploy: e.target.checked })} />
        <span>{t(info.live ? "settings.server.pushDeploy" : "settings.server.pushDeployDev")}</span>
      </label>
      {info.max_running !== undefined && (
        <div className="mt-3 text-sm text-fg">
          <label className="flex flex-wrap items-center gap-2">
            <span>{t("settings.server.maxRunning")}</span>
            <select className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-60" value={asked?.max_running ?? info.max_running}
              disabled={!!asked} aria-busy={asked?.max_running !== undefined} onChange={(e) => setting({ max_running: Number(e.target.value) })}>
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



/**
 * A model, chosen from the list the runtime itself gives (Claude Code's and Codex's own model lists). "Other…" takes
 * a full model name for the rare case; a saved name not in the list is shown as it is.
 */
export function ModelSelect({ runtime, value, onChange, defaultLabel = t("run.default"), className = "", disabled }: {
  runtime: "claude" | "codex"; value: string; onChange: (v: string) => void; defaultLabel?: string; className?: string; disabled?: boolean;
}) {
  const models = useQuery<ModelInfo[]>(`/api/models/${runtime}`, runtime).data;
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
  const models = useQuery<ModelInfo[]>(`/api/models/${runtime}`, runtime).data;
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

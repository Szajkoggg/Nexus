// Actions the agents wanted but were refused (sessions/<id>/refusals.jsonl): per step, and per project grouped by
// kind. From a Claude Code refusal the user can add an allow rule to the project's Nexus settings; Codex refusals are
// shown only (Nexus does not write Codex's own configuration).
import { useState } from "react";
import type { Refusal } from "@nexus/protocol";
import { groupRefusals, refusalKind, suggestAllowRule } from "@nexus/protocol/refusals";
import { act, enc, useFetch, type ProjectState } from "../api.ts";
import { Button, Section, TimeAgo } from "./ui.tsx";
import { rich, t, type Key } from "../i18n.ts";

const BY: Record<Refusal["by"], Key> = {
  permissions: "refusals.by.permissions",
  nexus: "refusals.by.nexus",
  auto_review: "refusals.by.autoReview",
};

/** The refusals of one step. */
export function StepRefusals({ project, queue, step }: { project: ProjectState; queue: string; step: string }) {
  const id = project.project.id;
  const list = useFetch<Refusal[]>(`/api/projects/${enc(id)}/refusals?queue=${enc(queue)}&step=${enc(step)}`, project.generated_at);
  const [open, setOpen] = useState<string>();
  if (!list?.length) return null;
  return (
    <Section title={t("refusals.title")} aside={<span className="text-xs text-fg-3">{list.length}</span>}>
      <ul className="space-y-2">
        {[...list].reverse().map((r, i) => {
          const key = r.ref ?? `${r.at}/${i}`;
          return (
            <li key={key} className="rounded-lg border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
                <span className="font-medium text-stop">{refusalKind(r).label}</span>
                <span>· {t(BY[r.by])}</span>
                <span className="ml-auto"><TimeAgo at={r.at} /></span>
              </div>
              {r.input && <div className="mt-1 break-all font-mono text-xs text-fg">{r.input}</div>}
              {r.reason && <div className="mt-1 text-xs text-fg-2">{r.reason}</div>}
              <AllowRule project={project} refusal={r} open={open === key} onOpen={(o) => setOpen(o ? key : undefined)} />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Every refusal of the project, grouped by kind (tool, command prefix), with counts and the latest time. */
export function ProjectRefusals({ project }: { project: ProjectState }) {
  const id = project.project.id;
  const list = useFetch<Refusal[]>(`/api/projects/${enc(id)}/refusals`, project.generated_at);
  const [open, setOpen] = useState<string>();
  if (!list?.length) return null;
  const groups = groupRefusals(list);
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-2">{t("refusals.title")}</h2>
        <span className="text-xs text-fg-3">{list.length}</span>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {groups.map((g) => (
          <li key={g.key} className="px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium text-fg">{g.label}</span>
              <span className="rounded-full bg-surface-3 px-1.5 text-xs text-fg" title={t("refusals.howMany")}>{g.count}×</span>
              <span className="text-xs text-fg-3">{g.runtime === "claude" ? "Claude Code" : "Codex"}</span>
              <span className="ml-auto text-xs text-fg-3">{rich("refusals.latest", { time: <TimeAgo key="time" at={g.latest.at} /> })}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-3">
              {g.latest.input && <span className="min-w-0 break-all font-mono text-fg-2">{g.latest.input}</span>}
              {g.latest.queue && <span className="font-mono">{g.latest.queue}{g.latest.step ? `/${g.latest.step}` : ""}</span>}
            </div>
            <AllowRule project={project} refusal={g.latest} open={open === g.key} onOpen={(o) => setOpen(o ? g.key : undefined)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * From a Claude Code refusal: a rule for the project's Nexus settings ("Also allowed"), prefilled and editable, saved
 * only when the user confirms. Says so when the suggested rule is already there.
 */
function AllowRule({ project, refusal, open, onOpen }: { project: ProjectState; refusal: Refusal; open: boolean; onOpen: (open: boolean) => void }) {
  const suggested = suggestAllowRule(refusal);
  const [rule, setRule] = useState(suggested ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  if (!suggested) return null;
  const allowed = project.project.runtimes.claude.allowed_tools;
  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {allowed.includes(suggested)
          ? <span className="text-ok">{rich("refusals.allowedNow", { rule: <span key="rule" className="font-mono">{suggested}</span> })}</span>
          : <button className="text-accent hover:underline" onClick={() => { setRule(suggested); setMsg(undefined); onOpen(true); }}>{t("refusals.allow")}</button>}
        {msg && <span className={msg.ok ? "text-ok" : "text-danger"}>{msg.text}</span>}
      </div>
    );
  }
  const save = async () => {
    setBusy(true); setMsg(undefined);
    try {
      await act(project.project.id, "POST", "/settings/allow-rule", { rule });
      setMsg({ ok: true, text: t("refusals.added", { rule: rule.trim() }) });
      onOpen(false);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-2 rounded-lg bg-surface-2 p-3">
      <label className="text-xs text-fg-2">
        <span className="mb-1 block">{t("refusals.ruleLabel")}</span>
        <input value={rule} onChange={(e) => setRule(e.target.value)} spellCheck={false}
          className="w-full rounded-md border border-line-strong bg-canvas px-2 py-1 font-mono text-sm text-fg" />
      </label>
      <p className="mt-1.5 text-xs text-fg-3">
        {t("refusals.ruleNote")}
      </p>
      {msg && !msg.ok && <p className="mt-1.5 text-xs text-danger">{msg.text}</p>}
      <div className="mt-2 flex gap-2">
        <Button disabled={busy || !rule.trim()} onClick={() => void save()}>{t("refusals.addRule")}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => onOpen(false)}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

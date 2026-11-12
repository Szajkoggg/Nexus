// Actions the agents wanted but were refused (sessions/<id>/refusals.jsonl): per step, and per project grouped by
// kind. From a Claude Code refusal the user can add an allow rule to the project's Nexus settings; Codex refusals are
// shown only (Nexus does not write Codex's own configuration).
import { useState } from "react";
import type { Refusal } from "@nexus/protocol";
import { groupRefusals, refusalKind, suggestAllowRule } from "@nexus/protocol/refusals";
import { act, enc, useFetch, type ProjectState } from "../api.ts";
import { Button, Section, TimeAgo } from "./ui.tsx";

const BY: Record<Refusal["by"], string> = {
  permissions: "Claude Code's permissions",
  nexus: "declined by Nexus (unattended)",
  auto_review: "Codex's auto reviewer",
};

/** The refusals of one step. */
export function StepRefusals({ project, queue, step }: { project: ProjectState; queue: string; step: string }) {
  const id = project.project.id;
  const list = useFetch<Refusal[]>(`/api/projects/${enc(id)}/refusals?queue=${enc(queue)}&step=${enc(step)}`, project.generated_at);
  const [open, setOpen] = useState<string>();
  if (!list?.length) return null;
  return (
    <Section title="Refused actions" aside={<span className="text-xs text-zinc-600">{list.length}</span>}>
      <ul className="space-y-2">
        {[...list].reverse().map((r, i) => {
          const key = r.ref ?? `${r.at}/${i}`;
          return (
            <li key={key} className="rounded-lg border border-zinc-800 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                <span className="font-medium text-orange-300">{refusalKind(r).label}</span>
                <span>· {BY[r.by]}</span>
                <span className="ml-auto"><TimeAgo at={r.at} /></span>
              </div>
              {r.input && <div className="mt-1 break-all font-mono text-xs text-zinc-200">{r.input}</div>}
              {r.reason && <div className="mt-1 text-xs text-zinc-400">{r.reason}</div>}
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
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Refused actions</h2>
        <span className="text-xs text-zinc-600">{list.length}</span>
      </div>
      <ul className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800">
        {groups.map((g) => (
          <li key={g.key} className="px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium text-zinc-100">{g.label}</span>
              <span className="rounded-full bg-zinc-800 px-1.5 text-xs text-zinc-300" title="How many times">{g.count}×</span>
              <span className="text-xs text-zinc-500">{g.runtime === "claude" ? "Claude Code" : "Codex"}</span>
              <span className="ml-auto text-xs text-zinc-500">latest <TimeAgo at={g.latest.at} /></span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-zinc-500">
              {g.latest.input && <span className="min-w-0 break-all font-mono text-zinc-400">{g.latest.input}</span>}
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
          ? <span className="text-emerald-400">Allowed now: <span className="font-mono">{suggested}</span> (for runs started since)</span>
          : <button className="text-sky-400 hover:text-sky-300" onClick={() => { setRule(suggested); setMsg(undefined); onOpen(true); }}>Allow for this project…</button>}
        {msg && <span className={msg.ok ? "text-emerald-400" : "text-red-300"}>{msg.text}</span>}
      </div>
    );
  }
  const save = async () => {
    setBusy(true); setMsg(undefined);
    try {
      await act(project.project.id, "POST", "/settings/allow-rule", { rule });
      setMsg({ ok: true, text: `Added ${rule.trim()}.` });
      onOpen(false);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-2 rounded-lg bg-zinc-800/50 p-3">
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block">Allow rule for Claude Code workers</span>
        <input value={rule} onChange={(e) => setRule(e.target.value)} spellCheck={false}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-200" />
      </label>
      <p className="mt-1.5 text-xs text-zinc-500">
        Goes to this project's Nexus settings ("Also allowed"), for runs started from now on. The project's own files
        (.claude/settings.json, AGENTS.md) are not changed.
      </p>
      {msg && !msg.ok && <p className="mt-1.5 text-xs text-red-300">{msg.text}</p>}
      <div className="mt-2 flex gap-2">
        <Button disabled={busy || !rule.trim()} onClick={() => void save()}>Add rule</Button>
        <Button variant="quiet" disabled={busy} onClick={() => onOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

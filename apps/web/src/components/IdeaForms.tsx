// Shared user-decision forms. A draft pins its revision and preserves its request ID across an uncertain save.
import { useRef, useState, type ReactNode } from "react";
import type { IdeasResponse } from "@nexus/protocol/ideas";
import { projectUrl, request } from "../api.ts";
import { t } from "../i18n.ts";
import { usePage } from "../page.ts";

export const ideaInput = "w-full min-w-0 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg";
export const ideaButton = "rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs font-semibold text-fg hover:bg-surface-3 disabled:opacity-50 whitespace-normal break-words max-lg:min-h-10";
export const ideaCard = "rounded-xl border border-line bg-canvas p-3 space-y-3 [overflow-wrap:anywhere]";

export function IdeaField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-xs text-fg-2"><span>{label}</span>{children}</label>;
}

export function DecisionPicker({ data, value, onChange, exclude }: { data: IdeasResponse; value: string; onChange: (ref: string) => void; exclude?: string }) {
  const [search, setSearch] = useState("");
  const options = data.notes.flatMap((n) => n.entries.map((e) => ({ ...e, file: n.file, title: n.title }))).filter((e) => e.ref !== exclude);
  const shown = options.filter((e) => e.ref === value || `${e.file} ${e.title} ${e.date} ${e.content}`.toLowerCase().includes(search.toLowerCase()));
  const selected = options.find((e) => e.ref === value);
  return <div className="space-y-2">
    <IdeaField label={t("ideas.findDecision")}><input className={ideaInput} value={search} onChange={(e) => setSearch(e.target.value)} /></IdeaField>
    <IdeaField label={t("ideas.target")}><select data-decision-select className={ideaInput} value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">{t("ideas.chooseDecision")}</option>
      {shown.map((e) => <option key={e.ref} value={e.ref}>{e.title} · {e.date}</option>)}
    </select></IdeaField>
    {selected && <div className="space-y-1 text-xs text-fg-2"><p>{selected.title} · {selected.date}</p><code className="block break-all">{selected.ref}</code><pre className="whitespace-pre-wrap font-sans leading-relaxed">{selected.content}</pre></div>}
    {!shown.length && <p className="text-xs text-fg-3">{t("ideas.noTargets")}</p>}
  </div>;
}

export function useIdeaSave(project: string, kind: "links" | "statuses", currentRevision: string, onSaved: () => void) {
  const { reloaded, reload } = usePage();
  const [revision, setRevision] = useState(currentRevision);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<Record<string, unknown>>();
  const [acknowledged, setAcknowledged] = useState(false);
  const attempt = useRef<{ fields: string; body: Record<string, unknown> } | undefined>(undefined);
  const stale = revision !== currentRevision;
  const send = async (body: Record<string, unknown>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(undefined);
    try {
      await request(projectUrl(project, `/ideas/${kind}`), { method: "POST", body });
      setAcknowledged(true);
      await reloaded(projectUrl(project, "/ideas"));
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { running.current = false; setBusy(false); }
  };
  return {
    busy, error, stale, acknowledged, pending: !!pending,
    save: (fields: Record<string, unknown>) => {
      if (stale || running.current) return;
      const key = JSON.stringify({ ...fields, revision });
      const body = attempt.current?.fields === key ? attempt.current.body : { ...fields, revision, request_id: crypto.randomUUID() };
      attempt.current = { fields: key, body };
      setPending(body); void send(body);
    },
    retry: () => { if (pending) void send(pending); },
    refresh: async () => {
      if (running.current) return;
      running.current = true; setBusy(true);
      try {
        const data = await request<IdeasResponse>(projectUrl(project, "/ideas"));
        setRevision(data[kind].revision); setPending(undefined); setError(undefined); setAcknowledged(false); attempt.current = undefined; reload();
      } catch (e) { setError(`${t("ideas.refreshFailed")} ${e instanceof Error ? e.message : String(e)}`); }
      finally { running.current = false; setBusy(false); }
    },
  };
}

export function IdeaSaveState({ save }: { save: ReturnType<typeof useIdeaSave> }) {
  return <>
    {save.stale && <div role="alert" className="rounded-lg border border-warn/50 bg-warn/5 p-3 text-xs text-warn">{t("ideas.stale")}</div>}
    {save.error && <p role="alert" className="text-sm text-danger">{save.acknowledged ? `${t("ideas.savedRefreshFailed")} ` : ""}{save.error}</p>}
    {(save.stale || save.error) && <div className="flex flex-wrap gap-2">
      <button type="button" className={ideaButton} disabled={save.busy} onClick={() => void save.refresh()}>{t("ideas.refresh")}</button>
      {save.pending && <button type="button" className={ideaButton} disabled={save.busy} onClick={save.retry}>{t("ideas.retry")}</button>}
    </div>}
  </>;
}

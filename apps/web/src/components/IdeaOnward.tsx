// Idea-scoped conversations and direct, reviewable handoffs. Neither button grants permission to start a queue.
import { useEffect, useRef, useState } from "react";
import type { IdeaHandoff, IdeaScope, SessionFile, previewIdeaHandoff } from "@nexus/protocol";
import type { IdeaNoteView, IdeasResponse } from "@nexus/protocol/ideas";
import { actResult, enc, HttpError, projectUrl, useAction, useQuery } from "../api.ts";
import { chatHref } from "../hash.ts";
import { t } from "../i18n.ts";
import { nav } from "../nav.ts";
import { usePage } from "../page.ts";
import { ActionBar, Button, PanelBody, PanelHeader, ReadError } from "./ui.tsx";
import { IdeaField, ideaButton, ideaCard, ideaInput } from "./IdeaForms.tsx";
import { EntryState } from "./IdeaStatus.tsx";

type Preview = ReturnType<typeof previewIdeaHandoff>;
type Selection = Preview["selection"];
type Pending = { preview: Preview; request: { request_id: string; revision: string; selection: Selection } };
const scopeText = (s: IdeaScope) => `${s.file}${s.date ? `#${s.date}` : ""}`;
const handoffLayer = (scope: IdeaScope) => `idea-handoff:${JSON.stringify(scope)}`;

export function IdeaActions({ project, file }: { project: string; file: string }) {
  // The note owns the single action pair. Only the handoff preview selects dates.
  const scope = { file };
  const { busy, error, run } = useAction();
  const key = `idea-chat:${project}:${scopeText(scope)}`;
  const requestId = useRef<string | undefined>(undefined);
  const create = () => run(async () => {
    requestId.current ??= sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, requestId.current);
    const made = await actResult<SessionFile>(project, "POST", "/conversations", { idea: scope, request_id: requestId.current });
    if (!made) throw new Error(t("ideas.chatNotCreated"));
    sessionStorage.removeItem(key); requestId.current = undefined;
    return made.id;
  }, (id) => nav.open(`conversation:${id}`));
  return <div className="min-w-0 space-y-2" data-idea-actions>
    <div className="flex flex-wrap gap-2">
      <button className={ideaButton} disabled={busy} onClick={() => void create()}>{t("chat.aboutThis")}</button>
      <button className={`${ideaButton} bg-accent/15`} disabled={busy} onClick={() => nav.open(handoffLayer(scope))}>{t("chat.handOff")}</button>
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}

function Delivery({ project, record, retryable = true }: { project: string; record: IdeaHandoff; retryable?: boolean }) {
  const { busy, error, run } = useAction(), { reload } = usePage();
  const retry = () => run(() => actResult<IdeaHandoff>(project, "POST", `/ideas/handoffs/${enc(record.id)}/retry`), () => reload());
  return <div className="space-y-2 text-xs" data-handoff-record={record.id}>
    <p className={record.state === "delivered" ? "text-ok" : "text-warn"}>{t(`ideas.delivery.${record.state}`)} · {record.delivery?.at ?? record.created_at}</p>
    <p>{record.file} · {record.dates.join(", ") || t("ideas.contextOnly")} · {t(record.purpose === "plan" ? "ideas.planPurpose" : "ideas.contextOnly")}</p>
    {record.delivery && <a className="text-accent underline" href={chatHref(project, { orchestrator: record.delivery.session }, record.delivery.line)}>{t("ideas.viewMessage")}</a>}
    <details><summary>{t("ideas.sentSnapshot")}</summary><pre className="mt-2 whitespace-break-spaces break-all font-sans">{record.payload}</pre></details>
    {record.attempts.some((a) => a.error) && <details><summary>{t("ideas.deliveryAttempts")}</summary>{record.attempts.map((a, i) => <p key={i}>{a.at} · {a.error ?? t("ideas.delivery.delivered")}</p>)}</details>}
    {retryable && record.state !== "delivered" && <button disabled={busy} className={ideaButton} onClick={() => void retry()}>{t("ideas.retry")}</button>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

export function IdeaActivity({ project, file }: { project: string; file: string }) {
  const { version } = usePage();
  const chats = useQuery<SessionFile[]>(projectUrl(project, "/conversations"), version);
  const handoffs = useQuery<IdeaHandoff[]>(projectUrl(project, "/ideas/handoffs"), version);
  return <details data-idea-activity className="space-y-3 text-xs [overflow-wrap:anywhere]"><summary>{t("ideas.onwardHistory")}</summary>
    {(chats.error || handoffs.error) && <ReadError error={chats.error ?? handoffs.error!} />}
    {chats.data?.filter((c) => c.about?.idea?.file === file).map((c) => <p key={c.id}>
      <button data-idea-conversation={c.id} className="text-left text-accent underline" onClick={() => nav.open(`conversation:${c.id}`)}>{c.title} · {scopeText(c.about!.idea!)}{c.archived ? ` · ${t("ideas.archived")}` : ""}</button>
    </p>)}
    {handoffs.data?.filter((h) => h.file === file).slice().reverse().map((h) => <Delivery key={h.id} project={project} record={h} />)}
  </details>;
}

export function IdeaHandoffPanel({ project, value }: { project: string; value: string }) {
  const { version } = usePage();
  const { data, error } = useQuery<IdeasResponse>(projectUrl(project, "/ideas"), version);
  let scope: IdeaScope | undefined;
  try { scope = JSON.parse(value) as IdeaScope; } catch { /* A stale browser layer cannot select an arbitrary note. */ }
  const note = data?.notes.find((n) => n.file === scope?.file);
  const close = () => nav.close("idea-handoff");
  return <>
    <PanelHeader wrap where={t("ideas.handoffDestination")} title={t("chat.handOff")} onClose={close} status={scope && <code className="break-all text-xs">{scopeText(scope)}</code>} />
    {error && <ReadError error={error} />}
    {note && scope && data ? <HandoffForm project={project} scope={scope} note={note} data={data} close={close} />
      : <PanelBody>{data && <p>{t("ideas.notFound")}</p>}</PanelBody>}
  </>;
}

function HandoffForm({ project, scope, note, data, close }: { project: string; scope: IdeaScope; note: IdeaNoteView; data: IdeasResponse; close: () => void }) {
  const storage = `idea-handoff:${project}:${scopeText(scope)}`;
  const [restored] = useState<Pending | undefined>(() => { try { return JSON.parse(sessionStorage.getItem(storage) ?? "null") ?? undefined; } catch { return undefined; } });
  const [initial] = useState<Selection>(() => {
    const allowed = note.entries.filter((e) => e.effective?.disposition === "active" && e.effective.implementation !== "full");
    const dates = scope.date ? [scope.date] : allowed.map((e) => e.date);
    return restored?.request.selection ?? { file: note.file, dates, purpose: dates.length && dates.every((d) => allowed.some((e) => e.date === d)) ? "plan" : "context", instruction: "" };
  });
  const [selection, setSelection] = useState(initial), [preview, setPreview] = useState<Preview | undefined>(restored?.preview);
  const [pending, setPending] = useState(restored), [sent, setSent] = useState<IdeaHandoff>();
  const [previewError, setPreviewError] = useState<string>();
  const { busy, error, run } = useAction(), { reload } = usePage();
  // Compare current displayed source fields, excluding the handoff/chat history which this action itself adds.
  const source = JSON.stringify({ summary: note.summary, questions: note.questions, ideas: note.ideas,
    entries: note.entries.map((e) => ({ date: e.date, content: e.content, effective: e.effective })),
    links: data.links.items.filter((r) => note.entries.some((e) => e.ref === r.ref)) });
  const [baseline, setBaseline] = useState(source);
  const stale = !!preview && (source !== baseline || JSON.stringify(selection) !== JSON.stringify(preview.selection));
  useEffect(() => {
    if (restored) return;
    let active = true;
    void actResult<Preview>(project, "POST", "/ideas/handoffs/preview", initial).then((p) => { if (active && p) setPreview(p); }, (e: Error) => { if (active) setPreviewError(e.message); });
    return () => { active = false; };
  }, [project, initial, restored]);
  const refresh = () => run(async () => {
    const p = await actResult<Preview>(project, "POST", "/ideas/handoffs/preview", selection);
    if (p) { setPreview(p); setSelection(p.selection); setBaseline(source); setPreviewError(undefined); }
  });
  const send = () => run(async () => {
    if (!preview) return;
    const attempt = pending ?? { preview, request: { request_id: crypto.randomUUID(), revision: preview.revision, selection: preview.selection } };
    setPending(attempt); sessionStorage.setItem(storage, JSON.stringify(attempt));
    try {
      const result = await actResult<IdeaHandoff>(project, "POST", "/ideas/handoffs", attempt.request);
      if (result) {
        setSent(result); reload();
        if (result.state === "delivered") { sessionStorage.removeItem(storage); setPending(undefined); }
      }
    } catch (e) {
      // A definitive validation rejection saved nothing. An unknown/lost response retains the same request.
      if (e instanceof HttpError && [400, 404, 409].includes(e.status)) { sessionStorage.removeItem(storage); setPending(undefined); setBaseline(""); }
      throw e;
    }
  });
  const frozen = busy || !!pending || sent?.state === "delivered";
  return <>
    <PanelBody><div className="space-y-4 text-sm [overflow-wrap:anywhere]" data-idea-handoff>
      <section data-box="Handoff purpose"><IdeaField label={t("ideas.handoffPurpose")}><select className={ideaInput} disabled={frozen} value={selection.purpose} onChange={(e) => setSelection({ ...selection, purpose: e.target.value as Selection["purpose"] })}>
        <option value="plan">{t("ideas.planPurpose")}</option><option value="context">{t("ideas.contextOnly")}</option>
      </select></IdeaField></section>
      <section data-box="Selected dates" className="space-y-2"><h3 className="text-xs font-semibold">{t("ideas.exactDates")}</h3>
        {[...note.entries].reverse().map((e) => {
          const contextOnly = e.effective?.disposition !== "active" || e.effective.implementation === "full";
          return <label key={e.date} className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={frozen || (selection.purpose === "plan" && contextOnly)} checked={selection.dates.includes(e.date)} onChange={(event) => setSelection({ ...selection, dates: (event.target.checked ? [...selection.dates, e.date] : selection.dates.filter((d) => d !== e.date)).sort() })} />
            <span><b>{e.date}</b><EntryState entry={e} compact /><span className="block">{e.lead}</span>{contextOnly && <span className="block text-fg-3">{t("ideas.onlyContextDate")}</span>}</span></label>;
        })}
      </section>
      <IdeaField label={t("ideas.handoffInstruction")}><textarea className={ideaInput} rows={2} disabled={frozen} value={selection.instruction} onChange={(e) => setSelection({ ...selection, instruction: e.target.value })} /></IdeaField>
      {(stale || !preview) && <p className="text-xs text-warn">{t("ideas.previewStale")}</p>}
      {!pending && sent?.state !== "delivered" && <button className={ideaButton} disabled={busy} onClick={() => void refresh()}>{t("ideas.refreshPreview")}</button>}
      {preview && <section data-box="Payload" className={ideaCard}><h3 className="font-semibold">{t("ideas.messagePreview")}</h3><p>{preview.snapshot.title}</p><p className="text-xs">{preview.snapshot.summary}</p>
        {preview.snapshot.decisions.map((e) => <details key={e.ref}><summary className="text-xs">{e.ref} · {e.effective?.disposition} · {e.effective?.implementation}</summary><pre className="mt-2 whitespace-pre-wrap text-xs font-sans">{e.content}</pre></details>)}
        <p className="text-xs font-semibold">{t("ideas.notDecided")}</p><pre className="whitespace-pre-wrap text-xs font-sans">{[preview.snapshot.undecided.open, preview.snapshot.undecided.ideas].filter(Boolean).join("\n\n") || t("ideas.noQuestions")}</pre>
        <details><summary className="text-xs">{t("ideas.exactPayload")}</summary><pre className="mt-2 whitespace-break-spaces break-all text-xs font-sans" data-handoff-payload>{preview.payload}</pre></details>
      </section>}
      <p className="text-xs text-fg-3">{t("ideas.handoffScope")}</p><p className="text-xs text-warn">{t("ideas.handoffNoStart")}</p>
      {(previewError || error) && <p role="alert" className="text-xs text-danger">{error ?? previewError}</p>}
      {sent ? <Delivery project={project} record={sent} retryable={false} /> : <p role="status" className="text-xs text-fg-3">{t(pending ? "ideas.delivery.pending" : "ideas.notSent")}</p>}
    </div></PanelBody>
    <ActionBar primary={sent?.state !== "delivered" && <Button disabled={busy || !preview || (!pending && stale)} onClick={() => void send()}>{t(busy ? "ideas.sending" : pending ? "ideas.retry" : "ideas.sendHandoff")}</Button>}
      secondary={<Button variant="quiet" onClick={close}>{t("ideas.cancel")}</Button>} />
  </>;
}

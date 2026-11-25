// A conversation's model and effort, under its chat's header (queue CM; docs/ux/conversation-settings.md): a folded
// summary of the pair the next reply runs on (and, while a reply runs on another pair, that one beside it), opening
// into an editor with the shared model and effort selectors. One save writes both; the server applies them from the
// next reply, never cutting the running one (apps/server/src/conversations.ts, update).
import { errorText } from "@nexus/protocol/errors";
import { useEffect, useState } from "react";
import type { ConversationSettings as Settings, ModelInfo } from "@nexus/protocol";
import { act, enc, useQuery } from "../api.ts";
import { changed, defaultLabel, draftOf, effortCheck, patchBody, summaryOf, type PairDraft } from "../conversationSettings.ts";
import { t } from "../i18n.ts";
import { EffortSelect, ModelSelect } from "./Settings.tsx";

export function ModelAndEffort({ project, id, runtime, own, settings, working, onSaved }: {
  project: string; id: string; runtime: "claude" | "codex";
  /** The conversation's own values (its session file): what the editor opens on. */
  own: { model?: string | null; effort?: string | null };
  settings: Settings;
  /** A reply is running (or waits for the old process): the summary shows the running pair beside the next one. */
  working: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PairDraft>(() => draftOf(own));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<"idle" | "working">();
  const models = useQuery<ModelInfo[]>(`/api/models/${runtime}`, runtime).data;
  const check = effortCheck(runtime, models, draft, settings.inherited);
  const summary = summaryOf(settings, working);
  // The saved notice lasts until a reply runs on the saved pair; a reply that was running at the save ends first.
  const applied = working && !!settings.running && !settings.changes;
  useEffect(() => {
    if (saved && applied) setSaved(undefined);
    else if (saved === "working" && !working) setSaved("idle");
  }, [saved, applied, working]);
  const toggle = () => {
    if (!open) { setDraft(draftOf(own)); setError(undefined); setSaved(undefined); }
    setOpen(!open);
  };
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await act(project, "PATCH", `/conversations/${enc(id)}`, patchBody(draft));
      setOpen(false);
      setSaved(working ? "working" : "idle");
      onSaved();
    } catch (e) {
      // The saved pair, this draft and the composer's text all stay: the error is shown here, Save can be tried again.
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const field = "w-full py-1.5 max-lg:min-h-11";
  return (
    <section aria-label={t("chat.settings.title")} className="border-b border-line px-5 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <button type="button" onClick={toggle} aria-expanded={open}
          className="-mx-1 flex items-center gap-1.5 rounded px-1 font-semibold text-fg hover:bg-surface-3 max-lg:min-h-9">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          {t("chat.settings.title")}
        </button>
        {summary.running
          ? <>
              <span className="text-fg-2"><b className="font-semibold text-fg">{t("chat.settings.running")}</b> {summary.running}</span>
              <span className="text-fg-2"><b className="font-semibold text-fg">{t("chat.settings.nextReply")}</b> {summary.next}</span>
            </>
          : <span className="text-fg-2">{summary.next}</span>}
        {saved && !open && <span role="status" className="text-xs text-ok">{t(saved === "working" ? "chat.settings.savedWorking" : "chat.settings.saved")}</span>}
      </div>
      {open && (
        <form className="mt-2.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="grid gap-x-3 gap-y-2 min-[420px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <label className="block font-semibold text-fg" htmlFor={`${id}-model`}>{t("run.field.model")}
              <span className="mt-1 block font-normal">
                <ModelSelect id={`${id}-model`} runtime={runtime} value={draft.model} disabled={saving} className={field}
                  defaultLabel={defaultLabel(settings.inherited.model)} onChange={(model) => setDraft({ ...draft, model })} />
              </span>
            </label>
            <label className="block font-semibold text-fg" htmlFor={`${id}-effort`}>{t("run.field.effort")}
              <span className="mt-1 block font-normal">
                <EffortSelect id={`${id}-effort`} runtime={runtime} model={draft.model} value={draft.effort} offered={check.efforts} disabled={saving} className={field}
                  defaultLabel={defaultLabel(settings.inherited.effort)} onChange={(effort) => setDraft({ ...draft, effort })} />
              </span>
            </label>
          </div>
          {check.issue && <p role="alert" className="mt-1.5 text-xs text-danger">{check.issue}</p>}
          {!check.issue && check.note && <p className="mt-1.5 text-xs text-fg-3">{check.note}</p>}
          {error && <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" onClick={() => setDraft({ model: "", effort: "" })} disabled={saving}
              className="rounded px-1 text-accent hover:underline disabled:opacity-40 max-lg:min-h-11">{t("chat.settings.useDefaults")}</button>
            <span className="flex-1" />
            <button type="button" onClick={() => { setOpen(false); setError(undefined); }} disabled={saving}
              className="rounded-md px-3 py-1.5 text-fg hover:bg-surface-3 disabled:opacity-40 max-lg:min-h-11">{t("common.cancel")}</button>
            <button type="submit" disabled={saving || !!check.issue || !changed(draft, own)}
              className="rounded-md bg-accent-strong px-3 py-1.5 font-medium text-on-accent hover:bg-accent disabled:opacity-40 max-lg:min-h-11">{t("common.save")}</button>
          </div>
        </form>
      )}
    </section>
  );
}

// The project's Danger zone, at the bottom of its settings: removing it from Nexus, or deleting Nexus's data of it too
// (docs/protocol/files.md, "Removing a project"). Both are the user's only, confirmed in place: Remove with one more click, Delete
// with the project's name typed. While anything runs in the project both are off, and the zone says what runs.
import { useState, type ReactNode } from "react";
import type { ProjectFile } from "@nexus/protocol";
import type { ProjectSummary, RemovalView } from "@nexus/protocol/api";
import { actResult, projectUrl, request, useAction, useQuery } from "../api.ts";
import { nav } from "../nav.ts";
import { usePage } from "../page.ts";
import { formatDateTime, t } from "../i18n.ts";
import { Button, Section } from "./ui.tsx";

type Level = "remove" | "delete";

/** The confirming button: the one that does it, marked as destructive. */
function DestroyButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="rounded-md border border-danger/60 bg-danger/15 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/25 disabled:cursor-not-allowed disabled:opacity-40 max-lg:min-h-11 max-lg:px-4">
      {children}
    </button>
  );
}

/** One of the two levels: what it does, and its button. */
function LevelRow({ title, text, button, disabled, open, onOpen }: { title: string; text: ReactNode; button: string; disabled: boolean; open: boolean; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-64">
        <div className="text-sm font-medium text-fg">{title}</div>
        <div className="mt-0.5 text-xs text-fg-2">{text}</div>
      </div>
      <Button variant="danger" onClick={onOpen} disabled={disabled} pressed={open}>{button}</Button>
    </div>
  );
}

/** A short list under a heading, or nothing when it is empty. */
function List({ title, items }: { title: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-fg-2">{title}</div>
      <ul className="mt-1 space-y-0.5">{items.map((x, i) => <li key={i} className="flex gap-2 text-xs text-fg"><span className="text-fg-3">·</span><span className="min-w-0 break-words">{x}</span></li>)}</ul>
    </div>
  );
}

const code = (s: string) => <code className="break-all rounded bg-surface-2 px-1 py-px text-[11px]">{s}</code>;

/** What a removal takes along and what it leaves, as the confirmation lists them. */
function Consequences({ view, level, root }: { view: RemovalView; level: Level; root: string }) {
  const goes = [
    ...view.planned.map((p) => t("danger.goes.planned", { queue: p.queue, after: p.after.join(", ") || "—" })),
    ...view.scheduled.map((s) => t("danger.goes.scheduled", { queue: s.queue, at: formatDateTime(s.at) })),
    ...view.questions.map((q) => t("danger.goes.question", { where: [q.queue, q.step].filter(Boolean).join("/") || t("danger.goes.project"), text: q.text })),
  ];
  const stays: ReactNode[] = [
    <>{t("danger.stays.files")} {code(root)}</>,
    ...(level === "remove" ? [<>{t("danger.stays.nexus")} {code(view.nexus_dir)}</>] : []),
    ...view.worktrees.map((w) => <>{t(w.exists ? "danger.stays.worktree" : "danger.stays.worktreeGone", { queue: w.queue, branch: w.branch ?? "—" })} {code(w.path)}</>),
  ];
  return (
    <>
      {level === "delete" && <List title={t("danger.deletes")} items={[<>{t("danger.deletes.nexus")} {code(view.nexus_dir)}</>]} />}
      <List title={t("danger.goes")} items={goes} />
      <List title={t("danger.stays")} items={stays} />
    </>
  );
}

/** After a removal: on to another project, or to the empty start when none is left. */
async function leave(removed: string): Promise<void> {
  const rest = (await request<ProjectSummary[]>("/api/projects").catch(() => [] as ProjectSummary[])).filter((p) => p.id !== removed);
  if (rest[0]) nav.closeThenItem("settings", rest[0].id);
  else { nav.close("settings"); location.hash = "#/"; }
}

export function DangerZone({ project }: { project: ProjectFile }) {
  const { version } = usePage();
  const view = useQuery<RemovalView>(projectUrl(project.id, "/removal"), version).data;
  const [open, setOpen] = useState<Level>();
  const [typed, setTyped] = useState("");
  const action = useAction();
  const blocked = !view || view.blockers.length > 0;
  // Something started to run while a confirmation was open: it closes (the buttons are off now).
  const level = blocked ? undefined : open;
  const confirmTitle = level && view ? t(level === "remove" ? "danger.remove.confirmTitle" : "danger.delete.confirmTitle", { name: view.name }) : "";
  const toggle = (l: Level) => { setOpen((x) => (x === l ? undefined : l)); setTyped(""); action.fail(undefined); };
  const remove = (l: Level) => void action.run(
    () => actResult(project.id, "POST", "/remove", l === "delete" ? { delete_data: true, name: typed } : {}),
    () => void leave(project.id),
  );
  return (
    <div id="danger-zone">
      <Section title={t("danger.title")}>
        <div className="rounded-lg border border-danger/40 p-3">
          {view && view.blockers.length > 0 && (
            <div className="mb-3 rounded-md border border-warn/30 bg-warn/10 p-2.5" role="status">
              <p className="text-sm text-warn">{t("danger.blocked")}</p>
              <ul className="mt-1 space-y-0.5">{view.blockers.map((b) => <li key={b} className="flex gap-2 text-sm text-fg"><span className="text-fg-3">·</span>{b}</li>)}</ul>
            </div>
          )}
          <div className="divide-y divide-line">
            <LevelRow title={t("danger.remove.title")} button={t("danger.remove.open")} disabled={blocked} open={level === "remove"} onOpen={() => toggle("remove")}
              text={<>{t("danger.remove.text")} {code(`nexus project add ${project.root}`)}</>} />
            <LevelRow title={t("danger.delete.title")} button={t("danger.delete.open")} disabled={blocked || !!view?.delete_refused} open={level === "delete"} onOpen={() => toggle("delete")}
              text={view?.delete_refused ? <span className="text-warn">{t("danger.delete.refused", { reason: view.delete_refused })}</span> : t("danger.delete.text")} />
          </div>
          {level && view && (
            <div className="mt-3 rounded-md border border-danger/40 bg-danger/5 p-3" role="group" aria-label={confirmTitle}>
              <p className="text-sm font-medium text-fg">{confirmTitle}</p>
              <Consequences view={view} level={level} root={project.root} />
              {level === "delete" && (
                <label className="mt-3 block text-xs text-fg-2">
                  {t("danger.delete.type", { name: view.name })}
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label={t("danger.delete.typeLabel")}
                    className="mt-1 block w-full max-w-sm rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm text-fg" />
                </label>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <DestroyButton onClick={() => remove(level)} disabled={action.busy || (level === "delete" && typed.trim() !== view.name)}>
                  {t(action.busy ? "danger.working" : level === "remove" ? "danger.remove.confirm" : "danger.delete.confirm")}
                </DestroyButton>
                <Button variant="quiet" onClick={() => toggle(level)} disabled={action.busy}>{t("common.cancel")}</Button>
                {action.error && <span className="text-sm text-danger">{action.error}</span>}
              </div>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

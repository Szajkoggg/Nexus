// A commit's details, opened from a commit hash in a chat message (Refs.tsx): its subject, hash, author, date and the
// files it changed with their lines added and removed (GET /api/projects/:id/commits/:hash, PROTOCOL.md "Files and
// commits"). A layer in the history ("commit:<hash>"), shown in a drawer; the hash is checked when it opens, so a
// hash-like word that is no commit says "not found" here.
import { useEffect, useState } from "react";
import { enc } from "../api.ts";
import { formatDateTime, t } from "../i18n.ts";
import { TimeAgo } from "./ui.tsx";

interface CommitDetail {
  sha: string; subject: string; author: string; at: string;
  files: { path: string; insertions: number | null; deletions: number | null }[]; insertions: number; deletions: number;
}
type Loaded = { kind: "loading" } | { kind: "error"; status: number; reason: string } | { kind: "ok"; commit: CommitDetail };

export function CommitDetails({ project, hash }: { project: string; hash: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    setLoaded({ kind: "loading" });
    fetch(`/api/projects/${enc(project)}/commits/${enc(hash)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({})) as CommitDetail & { error?: string };
        return r.ok ? { kind: "ok", commit: body } as const : { kind: "error", status: r.status, reason: body.error ?? r.statusText } as const;
      })
      .then((x) => { if (alive) setLoaded(x); }, (e: Error) => { if (alive) setLoaded({ kind: "error", status: 0, reason: e.message }); });
    return () => { alive = false; };
  }, [project, hash]);

  if (loaded.kind === "loading") return <p className="text-sm text-fg-3">{t("common.loading")}</p>;
  if (loaded.kind === "error") {
    return (
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-3">{t("commit.title")} <span className="font-mono normal-case">{hash}</span></h2>
        <p className="text-sm text-danger">{loaded.status === 404 || loaded.status === 400 ? t("commit.notFound", { hash }) : t("commit.failed", { reason: loaded.reason })}</p>
      </div>
    );
  }
  const c = loaded.commit;
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[5.5rem_1fr] gap-3 py-1 text-sm">
      <dt className="text-fg-3">{label}</dt><dd className="min-w-0 text-fg">{value}</dd>
    </div>
  );
  return (
    <div>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-3">{t("commit.title")}</h2>
      <p className="mb-4 pr-8 text-base font-semibold leading-snug text-fg">{c.subject}</p>
      <dl className="mb-5 border-y border-line py-2">
        {row(t("commit.hash"), <span className="select-all break-all font-mono text-xs leading-5">{c.sha}</span>)}
        {row(t("commit.author"), c.author)}
        {row(t("commit.date"), <>{formatDateTime(c.at)} <span className="text-fg-3">· <TimeAgo at={c.at} /></span></>)}
      </dl>
      <div className="mb-2 text-sm text-fg-2">
        {t("commit.files", { count: c.files.length })} · <span className="text-ok">+{c.insertions}</span> <span className="text-danger">−{c.deletions}</span>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface-2">
        {c.files.map((f) => (
          <li key={f.path} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg">{f.path}</span>
            <span className="shrink-0 whitespace-nowrap font-mono text-xs">
              {f.insertions === null ? <span className="text-fg-3">{t("commit.binary")}</span>
                : <><span className="text-ok">+{f.insertions}</span> <span className="text-danger">−{f.deletions}</span></>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Git in a step's and a queue's panel: the step's commits per round, the integration step's merge back, a finished
// worktree's merge and cleanup, the queue's branch, and what became of pushing an accepted step.
import { useState } from "react";
import type { BranchView, StepCommitsView } from "@nexus/protocol/api";
import { act, actResult, enc, HttpError, projectUrl, useAction, useQuery, type ProjectState, type QueueView, type StepView } from "../../api.ts";
import { integrationState, showsWorktreeActions } from "../../details.ts";
import { rich, t } from "../../i18n.ts";
import { Button, Section, TimeAgo } from "../ui.tsx";
import { Fold } from "./review.tsx";
import { usePage } from "../../page.ts";

/** The commits of each round of the step (server: src/gitinfo.ts); nothing outside a git repository. */
export function StepCommits({ project, queue, step, toggle }: {
  project: string; queue: string; step: string;
  /** The review's one line: "Commits · 3", which opens and closes the list. */
  toggle?: { open: boolean; onToggle: () => void };
}) {
  const data = useQuery<StepCommitsView | null>(projectUrl(project, `/queues/${enc(queue)}/steps/${enc(step)}/commits`), usePage().version).data;
  if (!data) return null;
  if (toggle) {
    const n = data.rounds.reduce((k, r) => k + r.commits.length, 0);
    return <Fold label={t("details.commitsCount", { count: n })} open={toggle.open} onToggle={toggle.onToggle} />;
  }
  const several = data.rounds.length > 1;
  const foreign = data.rounds.some((r) => r.commits.some((c) => c.foreign));
  return (
    <Section title={t("details.commits")} aside={foreign ? <span className="text-xs text-warn/80">◆ {t("details.commits.foreign")}</span> : undefined}>
      <div className="space-y-3">
        {data.rounds.map((r, i) => (
          <div key={i}>
            {several && <div className="mb-1 text-xs text-fg-3">{t(r.open ? "details.commits.roundAtWork" : "details.commits.round", { round: i + 1 })}</div>}
            {r.commits.length === 0
              ? <p className="text-sm text-fg-3">{t(r.open ? "details.commits.noneYet" : "details.commits.none")}</p>
              : (
                <ul className="space-y-1.5">
                  {r.commits.map((c) => (
                    <li key={c.sha} className="text-sm">
                      <div className="flex gap-2">
                        <span className="shrink-0 font-mono text-xs leading-5 text-fg-3">{c.sha.slice(0, 7)}</span>
                        <span className={`min-w-0 ${c.foreign ? "text-warn" : "text-fg"}`}>{c.foreign && <span className="text-warn" title={t("details.commits.foreignTitle")}>◆ </span>}{c.subject}</span>
                      </div>
                      <div className="pl-[3.75rem] text-xs text-fg-3">
                        {t("stop.files", { count: c.files })} · <span className="text-ok/80">+{c.insertions}</span> <span className="text-danger/80">−{c.deletions}</span> · {c.author} · <TimeAgo at={c.at} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * The integration step's box (PROTOCOL.md, "The integration step", "Merge back and clean up"): what it does, and how
 * the merge back stands: done (by Nexus or you), waiting (and why), run again because the base moved on, or the user's
 * when the project's merge_back is off.
 */
export function IntegrationBox({ project, queue, step }: { project: ProjectState; queue: QueueView; step: StepView }) {
  const { base, merged, waiting, again } = integrationState(queue, step);
  const code = (s: string, key: string) => <span key={key} className="font-mono">{s}</span>;
  const own = project.project.defaults.merge_back;
  return (
    <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${waiting ? "border-warn/40 bg-warn/5" : "border-line"}`}>
      <p className="text-xs text-fg-3">{rich("integration.box", { base: code(base, "base"), branch: code(queue.branch ?? t("details.worktree.itsBranch"), "branch") })}</p>
      {merged && (
        <p className="mt-1.5 text-ok">
          {rich(merged.by === "nexus" ? "integration.mergedByNexus" : "integration.mergedByYou", { into: code(merged.into, "into"), sha: code(merged.sha.slice(0, 7), "sha") })}
          {" "}<span className="text-xs text-fg-3">· <TimeAgo at={merged.at} /></span>
        </p>
      )}
      {!merged && waiting && (
        <p className="mt-1.5 text-warn"><span className="text-fg-3">{t("integration.waiting")} </span>{waiting.reason} <span className="text-xs text-fg-3">· <TimeAgo at={waiting.since} /></span></p>
      )}
      {!merged && !waiting && step.status === "done" && queue.status === "done" && (
        <p className="mt-1.5 text-fg-2">{own ? t("integration.byNexusSoon") : t("integration.yours")}</p>
      )}
      {again > 0 && !merged && <p className="mt-1 text-xs text-fg-3">{t("integration.again", { count: again })}</p>}
    </div>
  );
}

/**
 * A finished queue with a worktree of its own: merge its branch back into its base, and clean up (the worktree removed,
 * the branch deleted with -d). The user's only; each asks first and tells what it will do.
 */
export function WorktreeActions({ project, root, queue }: { project: string; root: string; queue: QueueView; }) {
  const { reload: onChanged } = usePage();
  const [ask, setAsk] = useState<"merge" | "cleanup">();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const g = queue.git;
  if (!showsWorktreeActions(queue, root)) return null;
  const branch = queue.branch ?? t("details.worktree.itsBranch");
  const base = g?.base?.branch !== false ? g?.base?.ref : undefined;
  const go = (what: "merge" | "cleanup") => {
    setBusy(true); setResult(undefined);
    actResult<{ message?: string }>(project, "POST", `/queues/${enc(queue.id)}/${what}`)
      .then((r) => { setResult({ ok: true, text: r?.message ?? t("details.worktree.done") }); setAsk(undefined); onChanged(); },
        (e: Error) => { setResult({ ok: false, text: e.message }); if (e instanceof HttpError) onChanged(); })
      .finally(() => setBusy(false));
  };
  return (
    <Section title={t("details.worktree")}>
      <p className="break-all text-xs text-fg-3">{rich(g?.base ? "details.worktree.onFrom" : "details.worktree.on", {
        path: <span key="path" className="font-mono">{queue.worktree}</span>, branch: <span key="branch" className="font-mono">{branch}</span>,
        base: <span key="base" className="font-mono">{g?.base?.ref}</span>,
      })}</p>
      {g?.merged && <p className="mt-1.5 text-sm text-ok">{rich(g.merged.by === "nexus" ? "details.worktree.mergedByNexus" : "details.worktree.merged", {
        into: <span key="into" className="font-mono">{g.merged.into}</span>,
        how: g.merged.fast_forward ? t("details.worktree.fastForward") : t("details.worktree.mergeCommit", { sha: g.merged.sha.slice(0, 7) }),
      })} <span className="text-xs text-fg-3">· <TimeAgo at={g.merged.at} /></span></p>}
      {g?.cleaned
        ? <p className="mt-1.5 text-sm text-fg">{rich("details.worktree.cleaned", { branch: <span key="branch" className="font-mono">{g.cleaned.branch}</span> })} <span className="text-xs text-fg-3">· <TimeAgo at={g.cleaned.at} /></span></p>
        : (
          <div className="mt-2 flex flex-wrap gap-2">
            {base && !g?.merged && <Button variant="quiet" onClick={() => { setAsk("merge"); setResult(undefined); }}>{t("details.worktree.mergeInto", { base: base ?? "" })}</Button>}
            <Button variant="quiet" onClick={() => { setAsk("cleanup"); setResult(undefined); }}>{t("details.worktree.cleanUpAsk")}</Button>
          </div>
        )}
      {ask && !g?.cleaned && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
          {ask === "merge" ? (
            <>
              <p className="text-sm text-warn">{rich("details.worktree.mergeQuestion", { branch: <span key="branch" className="font-mono">{branch}</span>, base: <span key="base" className="font-mono">{base}</span> })}</p>
              <p className="mt-1 text-xs text-fg-2">{t(queue.steps.some((s) => s.integration) ? "details.worktree.mergeTextIntegrated" : "details.worktree.mergeText", { base: base ?? "" })}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-warn">{t("details.worktree.cleanUpQuestion")}</p>
              <p className="mt-1 text-xs text-fg-2">{rich("details.worktree.cleanUpText", { branch: <span key="branch" className="font-mono">{branch}</span> })}</p>
            </>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => go(ask)}>{t(busy ? "details.worktree.working" : ask === "merge" ? "details.worktree.merge" : "details.worktree.cleanUp")}</Button>
            <Button variant="quiet" onClick={() => setAsk(undefined)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}
      {result && <p className={`mt-2 break-all text-xs ${result.ok ? "text-ok" : "text-danger"}`}>{result.text}</p>}
    </Section>
  );
}

/** The queue's branch: ahead and behind of its base and of its remote-tracking ref (as last fetched: never fetched here). */
export function BranchLine({ project, queue }: { project: string; queue: string }) {
  const b = useQuery<BranchView | null>(projectUrl(project, `/queues/${enc(queue)}/git`), usePage().version).data;
  if (!b) return null;
  const counts = (x: { ahead: number; behind: number }) => (
    <span><span className="text-ok">{t("details.branch.ahead", { count: x.ahead })}</span>, <span className={x.behind ? "text-warn" : "text-fg-2"}>{t("details.branch.behind", { count: x.behind })}</span></span>
  );
  return (
    <div className="mt-3 space-y-0.5 rounded-lg bg-surface-2 p-3 text-sm text-fg">
      <p><span className="text-fg-3">{t("details.branch")} </span><span className="font-mono">{b.branch}</span></p>
      {b.base && <p className="text-xs">{counts(b.base)} <span className="text-fg-3">{t("details.branch.ofBase")}</span> <span className="font-mono">{b.base.ref}</span></p>}
      {b.upstream
        ? <p className="text-xs">{counts(b.upstream)} <span className="text-fg-3">{t("details.branch.of")}</span> <span className="font-mono">{b.upstream.ref}</span> <span className="text-fg-3">{b.upstream.at ? rich("details.branch.fetched", { time: <TimeAgo key="time" at={b.upstream.at} /> }) : t("details.branch.fetchedUnknown")}</span></p>
        : <p className="text-xs text-fg-3">{t("details.branch.noUpstream")}</p>}
    </div>
  );
}

/** What became of pushing an accepted step: pushed, not pushed (no remote), or failed with Push again. */
export function PushLine({ project, queue, step }: { project: string; queue: QueueView; step: string; }) {
  const { reload: onChanged } = usePage();
  const { busy, error, run } = useAction();
  const p = queue.push?.steps[step];
  if (!p) return null;
  const failed = p.result === "failed";
  const latest = failed && queue.push?.error?.step === step;
  return (
    <div className={`mt-4 rounded-lg border p-3 text-sm ${failed ? "border-danger/30 bg-danger/10" : p.result === "pushed" ? "border-ok/30 bg-ok/10" : "border-line-strong bg-surface-2"}`}>
      <p>
        <span className="text-fg-3">{t(failed ? "details.push.failed" : p.result === "pushed" ? "details.push.pushed" : "details.push.push")} </span>
        <span className={failed ? "text-danger" : "text-fg"}>{p.text}</span>
        <span className="text-xs text-fg-3"> · <TimeAgo at={p.at} /></span>
      </p>
      {failed && <p className="mt-1 text-xs text-fg-2">{t("details.push.failedText")}</p>}
      {latest && (
        <div className="mt-2 flex items-center gap-3">
          <Button variant="quiet" disabled={busy} onClick={() => void run(() => act(project, "POST", `/queues/${enc(queue.id)}/push`), onChanged)}>{t(busy ? "details.push.busy" : "details.push.again")}</Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}

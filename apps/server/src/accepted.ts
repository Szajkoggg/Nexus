// Pushing what was accepted. When a step enters review, the server records the HEAD of the queue's checkout; when a
// step is accepted (by the orchestrator or the user), it pushes that commit, never the branch tip, to the branch the
// queue runs on: `git push <remote> <sha>:refs/heads/<branch>`, the remote being the branch's upstream, else origin.
// A branch missing on the remote is created there. Like the push on deploy (src/deploy.ts): a plain push (git refuses
// anything but a fast-forward), no prompt, a time limit. A failed push does not undo the acceptance; it shows on the
// step and is tried again at the next acceptance or with "push again". On only with the project's
// defaults.push_accepted. Everything goes in queues/<id>/push.yaml (one writer: the server).
import { execFileSync } from "node:child_process";
import { ActionError, loadProjectState, normPath, now, type ProjectState, type ProjectStore, type PushFile, type QueueView } from "@nexus/protocol";
import { checkoutOf } from "./gitinfo.ts";
import { PUSH_ENV, PUSH_TIMEOUT_MS, pushFailure, runGit, type GitRunner } from "./deploy.ts";

const MOVED = "the remote branch has commits the accepted one does not; bring them into the branch, then push again";

export class AcceptedPusher {
  private readonly store: ProjectStore;
  private readonly changed: () => void;
  private readonly run: GitRunner;
  private readonly timeout: number;
  /** Queues with a push under way: one at a time per queue. */
  private readonly busy = new Map<string, Promise<void>>();

  constructor(store: ProjectStore, changed: () => void, o: { run?: GitRunner; timeout?: number } = {}) {
    this.store = store;
    this.changed = changed;
    this.run = o.run ?? runGit;
    this.timeout = o.timeout ?? PUSH_TIMEOUT_MS;
  }

  /** Waits for the pushes under way (tests). */
  async settled(): Promise<void> { while (this.busy.size) await Promise.all(this.busy.values()); }

  /** After every change: record the HEAD of steps that entered review, and push the newest acceptance not handled. */
  onChange(state: ProjectState): void {
    for (const q of state.queues) {
      this.recordReviews(q);
      // After a rejection nothing of the queue is pushed until the user approves a revision that deals with it.
      if (!state.project.defaults.push_accepted || this.busy.has(q.id) || q.rejection) continue;
      const latest = newestAcceptance(q);
      if (!latest) continue;
      const push = this.store.readPush(q.id);
      if (Object.values(push?.steps ?? {}).some((s) => s.acceptance === latest.event)) continue;
      this.start(q, latest.step, latest.event);
    }
  }

  /** "Push again": the step of the last failed push, again (the newest acceptance's commit includes the older ones). */
  pushAgain(queueId: string): string {
    const push = this.store.readPush(queueId);
    if (!push?.error) throw new ActionError(`queue ${queueId} has no failed push`, 409);
    if (this.busy.has(queueId)) throw new ActionError(`a push of queue ${queueId} is under way`, 409);
    if (this.view(queueId).rejection) throw new ActionError(`a step of queue ${queueId} was rejected: nothing of it is pushed until you approve a revision that deals with it`, 409);
    const step = push.steps[push.error.step];
    this.start(this.view(queueId), push.error.step, step?.acceptance ?? "push-again");
    return `pushing step ${push.error.step} of queue ${queueId} again`;
  }

  private view(queueId: string): QueueView {
    const q = loadProjectState(this.store).queues.find((x) => x.id === queueId);
    if (!q) throw new ActionError(`unknown queue ${queueId}`, 404);
    return q;
  }

  /** The HEAD of the queue's checkout for each step that entered review in a round not recorded yet. */
  private recordReviews(q: QueueView): void {
    const fresh = q.steps.filter((s) => s.status === "review" && s.finished_at && this.store.readPush(q.id)?.review[s.id]?.finished_at !== s.finished_at);
    if (!fresh.length) return;
    const dir = checkoutOf(this.store, q);
    let sha: string | null = null;
    if (dir) { try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || null; } catch { sha = null; } }
    const push = this.store.readPush(q.id) ?? { protocol: 1 as const, review: {}, steps: {} };
    for (const s of fresh) push.review[s.id] = { sha, finished_at: s.finished_at!, at: now() };
    this.store.writePush(q.id, push);
  }

  private start(q: QueueView, step: string, acceptance: string): void {
    const p = this.pushStep(q, step, acceptance)
      .catch((err) => this.record(q.id, step, acceptance, undefined, { result: "failed", text: (err as Error).message }))
      .finally(() => { this.busy.delete(q.id); this.changed(); });
    this.busy.set(q.id, p);
  }

  private async pushStep(q: QueueView, step: string, acceptance: string): Promise<void> {
    const sha = this.store.readPush(q.id)?.review[step]?.sha ?? undefined;
    const dir = checkoutOf(this.store, q);
    if (!dir) return this.record(q.id, step, acceptance, sha, { result: "failed", text: "the queue's worktree is not known" });
    if (!sha) return this.record(q.id, step, acceptance, sha, { result: "failed", text: "no commit was recorded when the step entered review (is the checkout a git repository?)" });
    const env = { ...process.env, ...PUSH_ENV };
    const git = (args: string[]) => this.run(dir, args, { env, timeout: this.timeout });
    const branch = q.branch ?? (await git(["branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!branch) return this.record(q.id, step, acceptance, sha, { result: "failed", text: "the queue's checkout is on no branch" });
    const upstream = (await git(["config", "--get", `branch.${branch}.remote`]).catch(() => ({ stdout: "" }))).stdout.trim();
    const remotes = (await git(["remote"]).catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    const remote = upstream || (remotes.includes("origin") ? "origin" : "");
    if (!remote) return this.record(q.id, step, acceptance, sha, { result: "skipped", text: `not pushed: ${branch} has no upstream remote and there is no origin` });
    try {
      const r = await git(["push", remote, `${sha}:refs/heads/${branch}`]);
      const already = /Everything up-to-date/i.test(r.stderr + r.stdout);
      await this.record(q.id, step, acceptance, sha, { result: "pushed", text: `${sha.slice(0, 7)} ${already ? "was already" : "is now"} ${remote}/${branch}` }, { remote, branch, dir });
    } catch (err) {
      await this.record(q.id, step, acceptance, sha, { result: "failed", text: pushFailure(err, this.timeout, MOVED) });
    }
  }

  /** Writes the outcome; a successful push also marks earlier failed steps whose commit it includes as pushed. */
  private async record(queueId: string, step: string, acceptance: string, sha: string | undefined, r: { result: "pushed" | "failed" | "skipped"; text: string }, pushed?: { remote: string; branch: string; dir: string }): Promise<void> {
    const at = now();
    const push: PushFile = this.store.readPush(queueId) ?? { protocol: 1, review: {}, steps: {} };
    push.steps[step] = { acceptance, sha, result: r.result, text: r.text, at };
    if (r.result === "failed") push.error = { text: r.text, at, sha, step };
    if (r.result === "pushed" && pushed && sha) {
      push.pushed = { sha, step, at, remote: pushed.remote, branch: pushed.branch };
      push.error = undefined;
      for (const [id, s] of Object.entries(push.steps)) {
        if (id === step || s.result !== "failed" || !s.sha) continue;
        const included = await this.run(pushed.dir, ["merge-base", "--is-ancestor", s.sha, sha], { env: process.env, timeout: this.timeout }).then(() => true, () => false);
        if (included) push.steps[id] = { ...s, result: "pushed", text: `pushed with step ${step}: ${r.text}`, at };
      }
    }
    this.store.writePush(queueId, push);
  }
}

/** The newest review.accepted of the queue (its step and event), if any. */
function newestAcceptance(q: QueueView): { step: string; event: string; at: string } | undefined {
  let best: { step: string; event: string; at: string } | undefined;
  for (const s of q.steps) for (const e of s.timeline) {
    if (e.type === "review.accepted" && s.status === "done" && (!best || e.at > best.at)) best = { step: s.id, event: e.id, at: e.at };
  }
  return best;
}


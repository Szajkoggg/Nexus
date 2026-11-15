// Nexus merging worktree queues back by itself (PROTOCOL.md, "Merging back by itself"; docs/ideas/
// parallel-worktrees-and-merge-back.md). One per project, looking after every change: a finished queue with an
// integration step, with the project's merge_back on, is judged (src/mergeback.ts, judgeMerge) and
//
// - moved into its base by a fast-forward to the integrated commit, when nothing keeps it;
// - integrated again when the base moved on since its integration step (the step back to pending, the queue's run
//   started), at most REINTEGRATION_LIMIT times; then it waits for the user;
// - held while a step is at work in the base's checkout: that run is held at its step's end (the engine's boundary
//   asks atBoundary), the fast-forward goes, and the run goes on (Engine.releaseHold);
// - left waiting, recorded in git.yaml `merge.waiting` (the user's waiting list, the orchestrator's notices), when the
//   checkout is dirty, the base is checked out nowhere or only in the live worktree, its checks failed, and the like.
//
// Nothing happens while Nexus updates, deploys or hands over (`busy`). After a merge back the worktree and branch are
// cleaned up once every provisional acceptance of the queue is confirmed; a Fix it until then runs in the worktree and
// goes through the integration step again. Nothing is pushed.
import { normPath, now, pendingProvisional, stepClosed, runGoing, type ProjectState, type ProjectStore, type QueueView } from "@nexus/protocol";
import { checkoutOf, patchGit } from "./gitinfo.ts";
import { ROOT } from "./lifecycle.ts";
import { cleanUp, fastForward, judgeMerge, reintegrate, withMergeLock } from "./mergeback.ts";

export interface MergerOptions {
  /** Starts a queue's run (Engine.start); throws when it cannot start now. */
  start: (queue: string) => void;
  /** Lets a run held at its step's end go on (Engine.releaseHold). */
  release: (queue: string, reason: string) => void;
  /** An update, a deploy or a hand-over is under way: nothing moves. */
  busy: () => boolean;
  /** This server's own checkout (the live worktree is never a target). */
  serverRoot?: string;
  /**
   * Asks for a look again (the server: its change notification). While something waits, git can change what holds it
   * (a commit in the base's checkout, a checkout of the base) without any file of the project changing.
   */
  poke?: () => void;
  /** How long after a look that left something waiting it looks again (default POLL_MS). */
  pollMs?: number;
}

/** How often a merge back that waits is looked at again. */
const POLL_MS = 30_000;

export class Merger {
  /** Checkouts (normalised, lower case) a fast-forward waits on, with the queue it is for. */
  private readonly waitingOn = new Map<string, string>();
  /** Runs held at a step's end for a fast-forward, by queue. */
  private readonly held = new Set<string>();
  /** The next look, while something waits. */
  private timer: NodeJS.Timeout | undefined;
  /** This look left something waiting (or held). */
  private waits = false;

  private readonly store: ProjectStore;
  private readonly o: MergerOptions;
  constructor(store: ProjectStore, o: MergerOptions) { this.store = store; this.o = o; }

  onChange(state: ProjectState): void {
    if (this.o.busy()) return;
    this.waits = false;
    const wanted = new Set<string>();
    for (const q of state.queues) {
      if (!q.steps.some((s) => s.integration)) continue;
      try { this.look(state, q, wanted); }
      catch (e) { this.wait(q, `queue ${q.id}: merging back failed: ${(e as Error).message.split("\n")[0]}`); }
    }
    for (const path of [...this.waitingOn.keys()]) if (!wanted.has(path)) this.waitingOn.delete(path);
    if (!this.waitingOn.size) this.releaseAll("nothing is merged back into its checkout now");
    if ((this.waits || this.waitingOn.size) && this.o.poke && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.o.poke!(); }, this.o.pollMs ?? POLL_MS);
      this.timer.unref?.();
    }
  }

  /** No more looks (the server shuts down). */
  shutdown(): void { clearTimeout(this.timer); this.timer = undefined; }

  /** The queues whose fast-forward waits on a checkout now: merges back in progress (a removal waits for them). */
  merging(): string[] { return [...new Set(this.waitingOn.values())]; }

  /**
   * The engine at a step's end of `queue`: held when a fast-forward waits on its checkout (it goes on after it).
   * False otherwise.
   */
  atBoundary(queue: string, step: string, state: ProjectState): false | { hold: string } {
    if (!this.waitingOn.size || this.o.busy()) return false;
    const q = state.queues.find((x) => x.id === queue);
    if (!q) return false;
    const path = key(checkoutOf(this.store, q) ?? state.project.root);
    const merging = this.waitingOn.get(path);
    if (!merging || merging === queue) return false;
    this.held.add(queue);
    return { hold: `held at the end of step ${step} while Nexus merges queue ${merging} back into this checkout (a fast-forward); it goes on right after` };
  }

  private look(state: ProjectState, q: QueueView, wanted: Set<string>): void {
    const integ = q.steps.find((s) => s.integration)!;
    const merge = q.git?.merge;
    // A run of the integration step again that could not start yet (the checkout busy, the limit): started when it can.
    if (merge?.reintegrating) {
      const opened = (integ.segments.at(-1)?.start ?? "") > merge.reintegrating;
      if (opened) { this.writeMerge(q, { ...merge, reintegrating: undefined }); return; }
      if (integ.status === "pending" && q.steps.every((s) => s === integ || stepClosed(q, s)) && !runGoing(q.run)) {
        try { this.o.start(q.id); } catch { this.waits = true; /* not now: looked at again */ }
      }
      return;
    }
    if (q.status !== "done" || q.git?.cleaned) return;
    const d = judgeMerge(this.store, state, q, "nexus", this.o.serverRoot ?? ROOT);
    switch (d.kind) {
      case "none":
        if (merge?.waiting) this.writeMerge(q, { ...merge, waiting: undefined });
        return;
      case "wait":
        return this.wait(q, d.reason);
      case "hold":
        wanted.add(key(d.path));
        this.waitingOn.set(key(d.path), q.id);
        return;
      case "reintegrate":
        withMergeLock(this.store, q.id, () => reintegrate(this.store, q, d, "nexus"));
        try { this.o.start(q.id); } catch { this.waits = true; /* looked at again (merge.reintegrating) */ }
        return;
      case "ff":
        withMergeLock(this.store, q.id, () => fastForward(this.store, q, d, "nexus"));
        this.waitingOn.delete(key(d.path));
        return;
      case "merged":
        return this.cleanup(state, q);
    }
  }

  /** After a merge back (by anyone), with merge_back on: the worktree and branch go once no provisional work waits. */
  private cleanup(state: ProjectState, q: QueueView): void {
    if (!state.project.defaults.merge_back || !q.git?.merged) return;
    if (q.steps.some(pendingProvisional)) {
      if (q.git.merge?.waiting) this.writeMerge(q, { ...q.git.merge, waiting: undefined });
      return; // the user's return batch shows it; a Fix it runs in the worktree
    }
    try { withMergeLock(this.store, q.id, () => cleanUp(this.store, q.id)); }
    catch (e) { this.wait(q, `queue ${q.id} is merged back, but its cleanup waits: ${(e as Error).message}`); }
  }

  /** Records what it waits for (once per reason: told to the user and the orchestrator). */
  private wait(q: QueueView, reason: string): void {
    this.waits = true;
    const merge = this.store.readGit(q.id)?.merge;
    if (merge?.waiting?.reason === reason) return;
    this.writeMerge(q, { ...merge, waiting: { reason, since: now() } });
  }

  private writeMerge(q: QueueView, merge: NonNullable<NonNullable<QueueView["git"]>["merge"]>): void {
    const empty = !merge.waiting && merge.reintegrations === undefined && !merge.reintegrating;
    patchGit(this.store, q.id, { merge: empty ? undefined : merge });
  }

  private releaseAll(reason: string): void {
    for (const id of this.held) {
      this.held.delete(id);
      try { this.o.release(id, reason); } catch { /* it was resumed or paused meanwhile */ }
    }
  }
}

const key = (path: string) => normPath(path).toLowerCase();

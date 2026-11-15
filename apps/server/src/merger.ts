// Nexus merging worktree queues back by itself (PROTOCOL.md, "Merging back by itself"; docs/ideas/
// parallel-worktrees-and-merge-back.md). One per project, looking after every change: a finished queue with an
// integration step, with the project's merge_back on, is judged (src/mergeback.ts, judgeMerge), in this order:
//
// - left waiting, recorded in git.yaml `merge.waiting` (the user's waiting list, the orchestrator's notices), when its
//   checks failed, the base moved on after REINTEGRATION_LIMIT runs again, the base is checked out nowhere or only in
//   the live worktree, and the like;
// - held first while a step is at work in the base's checkout: that run is held at its step's end (the engine's
//   boundary asks atBoundary), and only then is the rest judged, so a step's uncommitted work does not count as a
//   dirty checkout;
// - left waiting when the checkout has uncommitted changes to tracked files (untracked files never keep it);
// - integrated again when the base moved on since its integration step (the step back to pending, the queue's run
//   started) while the checkout stays held, so the base does not move on again meanwhile;
// - moved into its base by a fast-forward to the integrated commit; then the held runs go on (Engine.releaseHold).
//
// A hold lasts at most until the merge back's next decision: whenever it cannot go after all (a dirty checkout, failed
// checks, the limit, a run again that does not get through), the held runs go on at once, and the wait names them
// (`merge.waiting.released`), so the user and the orchestrator are told. Nothing stays held.
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

/** A run that is at work now (not waiting for a slot, the usage window, a retry or an approval). */
const going = (q: QueueView) => q.run?.state === "running" || q.run?.state === "pausing";

export class Merger {
  /** Checkouts (normalised, lower case) Nexus holds for a merge back, with the queue it is for. */
  private holding = new Map<string, string>();
  /** Runs held at a step's end for a merge back, by queue, with the checkout (key) they are held in. */
  private readonly held = new Map<string, string>();
  /** The waits this look found, recorded at its end, once it knows which held runs go on. */
  private found: { q: QueueView; reason: string }[] = [];
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
    this.found = [];
    const wanted = new Map<string, string>();
    for (const q of state.queues) {
      if (!q.steps.some((s) => s.integration)) continue;
      try { this.look(state, q, wanted); }
      catch (e) { this.wait(q, `merging back failed: ${firstLine(e)}`); }
    }
    // The checkouts no longer held: the runs held there go on, named in the wait of the queue they were held for.
    const letGo = [...this.held].filter(([, path]) => !wanted.has(path)).map(([run, path]) => ({ run, by: this.holding.get(path) }));
    this.holding = wanted;
    for (const w of this.found) this.record(w.q, w.reason, letGo.filter((x) => x.by === w.q.id).map((x) => x.run));
    for (const { run } of letGo) {
      this.held.delete(run);
      try { this.o.release(run, "the merge back it was held for"); } catch { /* it was resumed or paused meanwhile */ }
    }
    if ((this.waits || this.holding.size) && this.o.poke && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.o.poke!(); }, this.o.pollMs ?? POLL_MS);
      this.timer.unref?.();
    }
  }

  /** No more looks (the server shuts down). */
  shutdown(): void { clearTimeout(this.timer); this.timer = undefined; }

  /**
   * The engine at a step's end of `queue`: held when Nexus holds its checkout for a merge back (it goes on after the
   * fast-forward, or as soon as the merge back cannot go). False otherwise.
   */
  atBoundary(queue: string, step: string, state: ProjectState): false | { hold: string } {
    if (!this.holding.size || this.o.busy()) return false;
    const q = state.queues.find((x) => x.id === queue);
    if (!q) return false;
    const path = key(checkoutOf(this.store, q) ?? state.project.root);
    const merging = this.holding.get(path);
    if (!merging || merging === queue) return false;
    this.held.set(queue, path);
    return { hold: `held at the end of step ${step} while Nexus merges queue ${merging} back into this checkout (a fast-forward); it goes on right after` };
  }

  private look(state: ProjectState, q: QueueView, wanted: Map<string, string>): void {
    const integ = q.steps.find((s) => s.integration)!;
    let merge = q.git?.merge;
    // The checkout this queue held for its merge back at the last look, if any; a queue already holding one keeps it.
    const mine = [...this.holding].find(([, id]) => id === q.id)?.[0];
    const claim = (path: string) => { if (!wanted.has(path) || this.holding.get(path) === q.id) wanted.set(path, q.id); };
    const cannotStart = (e: unknown) => {
      this.waits = true; // not now: looked at again (merge.reintegrating)
      if (mine) this.wait(q, `queue ${q.id}'s integration step cannot run again now (${firstLine(e)}): it runs when it can`);
    };
    // The run again of its integration step goes on: the checkout stays held, for that step only (its checks and its
    // review included). A run that halted, waits (a question, the usage window, a retry) or ended lets it go, told.
    const whileGoing = () => {
      if (!mine) return;
      if (going(q) && integ.status !== "waiting") return claim(mine);
      this.wait(q, `queue ${q.id}'s integration step did not get through its run again (it is ${integ.status}${q.run ? `, its run ${q.run.state}` : ""}): Nexus merges it back once it has`);
    };
    // A run of the integration step again that could not start yet (the checkout busy, the limit): started when it can.
    if (merge?.reintegrating) {
      const opened = (integ.segments.at(-1)?.start ?? "") > merge.reintegrating;
      if (!opened) {
        if (integ.status === "pending" && q.steps.every((s) => s === integ || stepClosed(q, s)) && !runGoing(q.run)) {
          try { this.o.start(q.id); } catch (e) { return cannotStart(e); }
          if (mine) claim(mine);
          return;
        }
        return whileGoing();
      }
      // Its round opened: the request is used up; it may even be finished already, then it is judged at once.
      merge = { ...merge, reintegrating: undefined };
      this.writeMerge(q, merge);
    }
    if (q.git?.cleaned) return;
    if (q.status !== "done") return whileGoing();
    const d = judgeMerge(this.store, state, q, "nexus", this.o.serverRoot ?? ROOT);
    switch (d.kind) {
      case "none":
        // Its own run or integration step still ending keeps the hold; anything else lets it go (the user's own
        // doing, as merge_back off).
        if (mine && (going(q) || d.ending)) claim(mine);
        if (merge?.waiting) this.writeMerge(q, { ...merge, waiting: undefined });
        return;
      case "wait":
        return this.wait(q, d.reason);
      case "hold":
        return claim(key(d.path));
      case "reintegrate":
        withMergeLock(this.store, q.id, () => reintegrate(this.store, q, d, "nexus"));
        try { this.o.start(q.id); } catch (e) { return cannotStart(e); }
        return claim(key(d.path));
      case "ff":
        withMergeLock(this.store, q.id, () => fastForward(this.store, q, d, "nexus"));
        return; // its checkout is no longer held: the runs held there go on
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

  /** Something keeps it waiting: recorded at the look's end (record). */
  private wait(q: QueueView, reason: string): void {
    this.waits = true;
    this.found.push({ q, reason });
  }

  /**
   * Records what it waits for, told to the user and the orchestrator once per reason, and again when runs held for
   * it go on (`released`).
   */
  private record(q: QueueView, reason: string, released: string[]): void {
    const merge = this.store.readGit(q.id)?.merge;
    if (merge?.waiting?.reason === reason && !released.length) return;
    this.writeMerge(q, { ...merge, waiting: { reason, since: now(), ...(released.length ? { released } : {}) } });
  }

  private writeMerge(q: QueueView, merge: NonNullable<NonNullable<QueueView["git"]>["merge"]>): void {
    const empty = !merge.waiting && merge.reintegrations === undefined && !merge.reintegrating;
    patchGit(this.store, q.id, { merge: empty ? undefined : merge });
  }
}

const key = (path: string) => normPath(path).toLowerCase();

const firstLine = (e: unknown) => (e as Error).message.split("\n")[0]!;

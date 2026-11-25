// Nexus merging worktree queues back by itself (docs/protocol/files.md, "Merging back by itself"; docs/ideas/
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
// The merge train (protocol train.ts, docs/protocol/git.md "The merge train"): the queues that go back into one base integrate
// one at a time. A queue whose next step is its integration step is held at the end of the step before while another
// queue holds the base (its integration step runs, or it waits for its fast-forward) or is before it in line; its run
// goes on when its turn comes. A fast-forward that waits (`merge.waiting`) lets the next queue go; once it could go
// again while another queue holds the base, it queues up (`merge.queued`) and goes in its turn.
//
// Nothing happens while Nexus updates, deploys or hands over (`busy`). After a merge back the worktree and branch are
// cleaned up once every provisional acceptance of the queue is confirmed; a Fix it until then runs in the worktree and
// goes through the integration step again. Nothing is pushed.
//
// A survey run in a worktree of its own (`maintenance: survey`, no integration step: it leaves no commit, so there is
// nothing to merge back) has its worktree and branch cleaned up once it is done, whatever merge_back says: only when
// every step is done or skipped (a stopped or failed survey keeps its worktree, as evidence), no provisional acceptance
// waits, and the worktree is clean, untracked files included. One that is not clean stays, and the user is told what is
// left (git.yaml `cleanup.waiting`, the waiting list's "cleanup" item); Nexus does not try again, the user's Clean up
// does. Never with --force.
import { errorText } from "@nexus/protocol/errors";
import { runActive } from "@nexus/protocol/status-rules";
import { existsSync } from "node:fs";
import {
  hasOwnWorktree, mayIntegrate, mayMergeBack, normPath, now, pendingProvisional, stepClosed, runGoing, runOnTrack, trainBase, trainPlace, trainText, trainsOf,
  type ProjectState, type ProjectStore, type QueueView, type Train,
} from "@nexus/protocol";
import { checkoutOf, patchGit } from "./gitinfo.ts";
import { ROOT } from "./lifecycle.ts";
import { cleanUp, fastForward, judgeMerge, leftText, reintegrate, stillEnding, withMergeLock, worktreeLeft } from "./mergeback.ts";
import { samePath } from "./worktree.ts";
import type { RemovalIO } from "./cleanup-proof.ts";

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
  /** How a cleanup removes the worktree's files (a test's seam: a locked folder, fewer retries). */
  removal?: RemovalIO;
  /**
   * Ends the queue's worker processes (Engine.queueProcessesLeft); undefined when none is alive any more, else why the
   * cleanup waits ("" when they were only now asked to end). A cleanup waits until then (queue PRC): a process that still
   * runs in the worktree keeps its folder and may write into it. The reason is recorded as the cleanup's wait (queue
   * LCK, F2).
   */
  processesLeft?: (queue: string) => string | undefined;
}

/** How often a merge back that waits is looked at again. */
const POLL_MS = 30_000;

/** A run that is at work now (not waiting for a slot, the usage window, a retry or an approval). */
const going = (q: QueueView) => runActive(q.run);

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
  /** Runs held before their integration step for the merge train: let go when their turn comes. */
  private readonly trainHeld = new Set<string>();
  /** The merge trains at this look's start, by base (protocol train.ts). */
  private trains = new Map<string, Train>();
  /**
   * Queues whose cleanup by Nexus failed in an earlier look. The removal's retries wait synchronously (a Windows lock:
   * 9 s in all), and every look runs on the server's one loop before the orchestrator's requests are carried out; a
   * folder locked for hours blocked the loop for most of that time (queue CWA). Tried again without retries: the next
   * look comes within POLL_MS anyway.
   */
  private readonly cleanupFailed = new Set<string>();
  /** The bases a queue moved, or claimed, in this look: one queue per base and look. */
  private moved = new Set<string>();

  private readonly store: ProjectStore;
  private readonly o: MergerOptions;
  constructor(store: ProjectStore, o: MergerOptions) { this.store = store; this.o = o; }

  onChange(state: ProjectState): void {
    if (this.o.busy()) return;
    this.waits = false;
    this.found = [];
    this.trains = trainsOf(state.project, state.queues);
    this.moved = new Set();
    const wanted = new Map<string, string>();
    for (const q of state.queues) {
      if (ownSurvey(q)) { this.surveyCleanup(state, q); continue; }
      if (!q.steps.some((s) => s.integration)) continue;
      try { this.look(state, q, wanted); }
      catch (e) { this.wait(q, `queue ${q.id}: merging back failed: ${firstLine(e)}`); }
    }
    // The checkouts no longer held: the runs held there go on, named in the wait of the queue they were held for.
    const letGo = [...this.held].filter(([, path]) => !wanted.has(path)).map(([run, path]) => ({ run, by: this.holding.get(path) }));
    this.holding = wanted;
    for (const w of this.found) this.record(w.q, w.reason, letGo.filter((x) => x.by === w.q.id).map((x) => x.run));
    for (const { run } of letGo) {
      this.held.delete(run);
      try { this.o.release(run, "the merge back it was held for"); } catch { /* it was resumed or paused meanwhile */ }
    }
    this.releaseTrain(state);
    if (this.waits || this.holding.size || this.trainHeld.size) this.lookAgain();
  }

  /** Arms the next look (once), when the server gave a way to ask for one. */
  private lookAgain(): void {
    if (!this.o.poke || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.o.poke!(); }, this.o.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  /** No more looks (the server shuts down). */
  shutdown(): void { clearTimeout(this.timer); this.timer = undefined; }

  /** The queues whose fast-forward waits on a checkout now: merges back in progress (a removal waits for them). */
  merging(): string[] { return [...new Set(this.holding.values())]; }

  /**
   * The engine at a step's end of `queue`: held when Nexus holds its checkout for a merge back (it goes on after the
   * fast-forward, or as soon as the merge back cannot go); or before its integration step while it is not its turn in
   * the merge train (it goes on when it is). False otherwise.
   */
  atBoundary(queue: string, step: string, state: ProjectState): false | { hold: string } {
    const q = state.queues.find((x) => x.id === queue);
    if (!q) return false;
    if (this.holding.size && !this.o.busy()) {
      const path = key(checkoutOf(this.store, q) ?? state.project.root);
      const merging = this.holding.get(path);
      if (merging && merging !== queue) {
        this.held.set(queue, path);
        return { hold: `held at the end of step ${step} while Nexus merges queue ${merging} back into this checkout (a fast-forward); it goes on right after` };
      }
    }
    return this.trainHold(q, step, state);
  }

  /**
   * The merge train at a step's end: a queue whose next step is its integration step waits there while another queue
   * holds its base or is before it in line (protocol train.ts); its own steps before never wait.
   */
  private trainHold(q: QueueView, step: string, state: ProjectState): false | { hold: string } {
    const integ = q.steps.find((s) => s.integration);
    if (!integ || step === integ.id || q.steps.find((s) => s.status === "pending") !== integ) return false;
    const trains = trainsOf(state.project, state.queues);
    if (mayIntegrate(trains.get(trainBase(q)), q.id)) { this.trainHeld.delete(q.id); return false; }
    this.trainHeld.add(q.id);
    this.lookAgain(); // looked at again even when nothing else changes meanwhile
    const place = trainPlace(trains, q);
    return { hold: `held at the end of step ${step}: it ${place ? trainText(place) : "waits for its turn to integrate"}; it goes on by itself when its turn comes` };
  }

  /**
   * The runs held for the merge train whose turn came go on. One that is gone from there (its integration step opened,
   * its run ended otherwise, the queue gone) is forgotten; a state read just before the hold (the run still running)
   * keeps it.
   */
  private releaseTrain(state: ProjectState): void {
    for (const id of [...this.trainHeld]) {
      const q = state.queues.find((x) => x.id === id);
      if (!q || q.steps.find((s) => s.integration)?.status !== "pending" || !runOnTrack(q.run)) {
        this.trainHeld.delete(id);
        continue;
      }
      if (q.run!.state !== "paused" || !mayIntegrate(this.trains.get(trainBase(q)), id)) continue;
      this.trainHeld.delete(id);
      try { this.o.release(id, "its turn to integrate"); } catch { /* it was resumed or paused meanwhile */ }
    }
  }

  /**
   * The merge train before a queue moves its base (or holds its checkout for that): whether it is its turn. Not yet:
   * it queues up (`merge.queued`, ordered by when its wait began) and is looked at again.
   */
  private turn(q: QueueView, merge: Merge | undefined): boolean {
    const base = trainBase(q);
    if (!this.moved.has(base) && mayMergeBack(this.trains.get(base), q.id)) { this.moved.add(base); return true; }
    this.waits = true;
    if (!merge?.queued) this.writeMerge(q, { ...merge, waiting: undefined, queued: { since: merge?.waiting?.since ?? now() } });
    return false;
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
    // A crash after branch deletion must finish the recorded cleanup before judging the now absent branch.
    if (q.git?.cleanup_proof) return this.cleanup(state, q);
    const d = judgeMerge(this.store, state, q, "nexus", this.o.serverRoot ?? ROOT);
    switch (d.kind) {
      case "none":
        // Its own run or integration step still ending keeps the hold; anything else lets it go (the user's own
        // doing, as merge_back off).
        if (mine && (going(q) || d.ending)) claim(mine);
        if (merge?.waiting || (merge?.queued && !d.ending)) this.writeMerge(q, { ...merge, waiting: undefined, queued: undefined });
        return;
      case "wait":
        return this.wait(q, d.reason);
      case "hold":
        if (!this.turn(q, merge)) return;
        return claim(key(d.path));
      case "reintegrate":
        if (!this.turn(q, merge)) return;
        withMergeLock(this.store, q.id, () => reintegrate(this.store, q, d, "nexus"));
        try { this.o.start(q.id); } catch (e) { return cannotStart(e); }
        return claim(key(d.path));
      case "ff":
        if (!this.turn(q, merge)) return;
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
    if (!this.processesEnded(q, (reason) => this.wait(q, reason))) return;
    try { this.tryCleanUp(q.id); }
    catch (e) { this.wait(q, `queue ${q.id} is merged back, but its cleanup waits: ${errorText(e)}`); }
  }

  /**
   * A done survey run's worktree and branch go (see the header). A step whose turn is still ending (its round open)
   * holds it a moment: looked at again.
   */
  private surveyCleanup(state: ProjectState, q: QueueView): void {
    if (q.status !== "done" || runGoing(q.run) || q.git?.cleaned || (q.git?.cleanup && !q.git.cleanup.waiting.processes)) return;
    if (!q.steps.every((s) => s.status === "done" || s.status === "skipped") || q.steps.some(pendingProvisional)) return;
    if (q.steps.some((s) => stillEnding(q, s))) { this.waits = true; return; }
    const path = checkoutOf(this.store, q);
    if (!path || samePath(path, state.project.root)) return;
    const processes = (reason: string) => {
      if (q.git?.cleanup?.waiting.reason !== reason) patchGit(this.store, q.id, { cleanup: { waiting: { reason, since: now(), processes: true } } });
    };
    if (!this.processesEnded(q, processes)) return;
    let waiting: CleanupWaiting;
    try {
      this.tryCleanUp(q.id);
      return;
    } catch (e) {
      waiting = { reason: `survey run ${q.id} is done, but its worktree could not be cleaned up: ${firstLine(e)}`, since: now() };
      // Keep the useful status listing for an ordinary dirty tree, but never replace a proof refusal with status
      // from a partially removed tree (or with another unreadable-status error).
      if (existsSync(path) && !this.store.readGit(q.id)?.cleanup_proof && errorText(e).includes("has uncommitted changes (")) {
        try {
          const left = worktreeLeft(path);
          if (left.count) {
            const more = left.count - left.files.length;
            waiting = {
              reason: `survey run ${q.id} is done, but its worktree stays: ${leftText(left)} left in it; look at them, then clean up (${path})`,
              since: now(), files: left.files, ...(more ? { more } : {}),
            };
          }
        } catch { /* The cleanup's actionable refusal is already recorded above. */ }
      }
    }
    patchGit(this.store, q.id, { cleanup: { waiting } });
  }

  /**
   * The queue's worker processes have ended (asked to end now, if not): a cleanup may go. Else it waits a moment, looked
   * at again (their exits change the runtime records, which brings a look too), and `record` gets why, once there is a
   * reason to show.
   */
  private processesEnded(q: QueueView, record: (reason: string) => void): boolean {
    const left = this.o.processesLeft?.(q.id);
    if (left === undefined) return true;
    this.waits = true;
    if (left) record(left);
    return false;
  }

  /** A queue's cleanup: with the removal's retries the first time, without them once one failed (cleanupFailed). */
  private tryCleanUp(queue: string): void {
    const again = this.cleanupFailed.has(queue);
    try { cleanUp(this.store, queue, again ? { ...this.o.removal, retries: 0 } : this.o.removal); }
    catch (e) { this.cleanupFailed.add(queue); throw e; }
    this.cleanupFailed.delete(queue);
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
    this.writeMerge(q, { ...merge, queued: undefined, waiting: { reason, since: now(), ...(released.length ? { released } : {}) } });
  }

  private writeMerge(q: QueueView, merge: Merge): void {
    const empty = !merge.waiting && merge.reintegrations === undefined && !merge.reintegrating && !merge.queued;
    patchGit(this.store, q.id, { merge: empty ? undefined : merge });
  }
}

const key = (path: string) => normPath(path).toLowerCase();

/** A queue's merge back as git.yaml records it. */
type Merge = NonNullable<NonNullable<QueueView["git"]>["merge"]>;

/** What keeps a done survey run's worktree (git.yaml `cleanup.waiting`). */
type CleanupWaiting = NonNullable<NonNullable<QueueView["git"]>["cleanup"]>["waiting"];

/**
 * A survey run in a worktree of its own, as closing.ts tells it (and gives it no integration step): nothing to merge
 * back, its worktree is cleaned up once it is done.
 */
const ownSurvey = (q: QueueView) => q.maintenance === "survey" && hasOwnWorktree(q);

const firstLine = (e: unknown) => errorText(e).split("\n")[0]!;

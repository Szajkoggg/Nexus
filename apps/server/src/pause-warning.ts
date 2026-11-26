// The warning of a queue paused for long (queue IWS, docs/ux/idea-work-signals.md part c): the waiting item itself is
// derived when the state is read (@nexus/protocol attention-snoozes.ts), but nothing re-derives by itself over time.
// So after each change of a project this module finds the next moment a warning comes due (or a put-off ends) and sets
// one timer for it, which reports a change of the project: its state is derived again, and the attention watch raises
// the notification as for every other waiting item. It writes nothing and touches no run (no run-control file).
import { nextPauseWarning, type ProjectState, type ProjectStore } from "@nexus/protocol";
import { ClockTimers, REAL_CLOCK, type Clock } from "./scheduler.ts";

export class PauseWarnings {
  private readonly timers: ClockTimers;
  private readonly changed: (id: string) => void;

  /** `changed`: the project's change pass (main.ts); `stopped`: once true, a timer that comes does nothing. */
  constructor(changed: (id: string) => void, stopped: () => boolean, clock: Clock = REAL_CLOCK) {
    this.timers = new ClockTimers(clock, stopped);
    this.changed = changed;
  }

  /** Arms the project's timer for its next warning (none: disarmed). An unreadable put-off file counts as none. */
  arm(id: string, store: ProjectStore, state: ProjectState): number | undefined {
    let snoozes: ReturnType<ProjectStore["readAttentionSnoozes"]>["items"] = [];
    try { snoozes = store.readAttentionSnoozes().items; } catch { /* the state's warnings name the file */ }
    const next = nextPauseWarning(state.queues, state.project.defaults.paused_warning_days, snoozes, this.timers.clock.now());
    if (next === undefined) this.timers.clear(id);
    else this.timers.wakeAt(id, next, () => this.changed(id));
    return next;
  }
}

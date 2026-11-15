// The static analysis reminder (PROTOCOL.md, "Static analysis reminder"): while a project of a known stack has no
// static analysis (@nexus/protocol static-analysis.ts), once a month the server notes a reminder in
// .nexus/static-analysis.yaml, and the orchestrator is told to recommend the shipped "static-analysis" template to the
// user in a sentence. The user's no (the orchestrator's `nexus static-analysis decline`, arriving here through the
// server) rests it for 90 days. The only writer of .nexus/static-analysis.yaml.
import { lacksStaticAnalysis, projectStaticAnalysis, staticReminderDue, STATIC_REMIND_EVERY_MS, type ProjectStore, type StaticAnalysis } from "@nexus/protocol";
import type { ClockTimers } from "./scheduler.ts";

const KEY = "static-analysis";
const iso = (ms: number) => new Date(ms).toISOString();

export class StaticReminder {
  private readonly store: ProjectStore;
  private readonly timers: ClockTimers;
  private readonly changed: () => void;
  private readonly detect: (root: string) => StaticAnalysis;

  constructor(store: ProjectStore, timers: ClockTimers, changed: () => void, detect: (root: string) => StaticAnalysis = projectStaticAnalysis) {
    this.store = store;
    this.timers = timers;
    this.changed = changed;
    this.detect = detect;
  }

  private get now(): number { return this.timers.clock.now(); }

  /**
   * Looks now if the reminder is due, and arms the next look: when due and the project still has no static analysis,
   * the reminder is noted (and the orchestrator told); a project that has some is looked at again a month later.
   */
  arm(): void {
    const note = this.store.readStaticAnalysisNote();
    const due = staticReminderDue(note);
    if (due > this.now) { this.timers.wakeAt(KEY, due, () => this.arm()); return; }
    let lacks = false;
    try { lacks = lacksStaticAnalysis(this.detect(this.store.readProject().root)); } catch { /* an unreadable folder: no reminder */ }
    if (lacks) {
      this.store.writeStaticAnalysisNote({ ...note, reminded_at: iso(this.now) });
      this.changed();
    }
    this.timers.wakeAt(KEY, this.now + STATIC_REMIND_EVERY_MS, () => this.arm());
  }

  /** The user's no, told by the orchestrator: no reminder for 90 days. Returns what happened. */
  decline(reason: string, session?: string): string {
    const note = this.store.readStaticAnalysisNote();
    this.store.writeStaticAnalysisNote({ ...note, declined: { at: iso(this.now), reason, ...(session ? { session } : {}) } });
    this.timers.wakeAt(KEY, staticReminderDue(this.store.readStaticAnalysisNote()), () => this.arm());
    this.changed();
    return `noted: the user declined setting up static analysis; no reminder until ${iso(staticReminderDue(this.store.readStaticAnalysisNote()))}`;
  }
}

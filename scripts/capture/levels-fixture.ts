// A test project "demo" for review levels, provisional acceptances and away mode (queue RL), used by the capture
// tool's seeds seed-levels.ts (away mode off) and seed-levels-away.ts (on until 08:00). It writes only under the data
// directory and NEXUS_HOME the capture tool gives the development instance.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, awayUntil, newId, readAway, setStepLevel, turnAway, writeAway, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

export function seedLevels(dir: string, o: { away?: boolean } = {}): string {
  const root = join(dir, "demo");
  mkdirSync(root, { recursive: true });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
  writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
  // Reviewed by level from before the seeded events (else the server's first start would mark them as from before).
  st.markReviewLevels(ago(24 * 60));
  const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(600), ...(queue ? { queue } : {}) };
    st.writeSession(s);
    return s;
  };
  const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
  const orch = session("orchestrator", "Orchestrator");

  // LV: waits for approval; its steps at every level, one set by the user.
  st.writeQueue({ protocol: 1, id: "LV", title: "Onboarding tour", revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"],
    description: "A short tour for new users: four screens, then the first project.",
    steps: [
      { id: "LV1", title: "Tour data and routes", goal: "The tour's screens as data, each with its route.", acceptance: ["Unit tests for every screen's route"], review: { level: 2 } },
      { id: "LV2", title: "The tour's look", goal: "The four screens drawn, light and dark.", acceptance: ["The screens feel calm and readable"], review: { level: 1, prepare: "tour-screen@1440 result, tour-screen@390 result" } },
      { id: "LV3", title: "Skip and resume", goal: "The tour can be skipped and resumed later.", acceptance: ["A test for skip and one for resume"], review: { level: 3 } },
      { id: "LV4", title: "Copy edits", goal: "The tour's texts through the catalogue.", acceptance: ["No text left outside the catalogue"] },
    ] });
  setStepLevel(st, "LV", "LV4", 3);

  // BT: finished; two of its steps accepted provisionally, one accepted for good. CP: one step, accepted provisionally.
  const done = (q: string, steps: { id: string; title: string; decide: "provisional" | "accept"; note?: string; min: number }[], title: string) => {
    st.writeQueue({ protocol: 1, id: q, title, revision: 1, status: "proposed", review_level: 3, stop_conditions: [], checks: ["npm test"],
      steps: steps.map((s) => ({ id: s.id, title: s.title, goal: `${s.title}.`, acceptance: ["Done"] })) });
    approveQueue(st, q);
    const w = session("worker", `${q} worker`, q);
    for (const s of steps) {
      emit(w, s.min + 20, { type: "step.started", queue: q, step: s.id });
      emit(w, s.min + 2, { type: "step.done", queue: q, step: s.id, summary: `${s.title}: done.` });
      emit(orch, s.min, s.decide === "provisional" ? { type: "review.provisional", queue: q, step: s.id, text: s.note } : { type: "review.accepted", queue: q, step: s.id });
    }
  };
  done("BT", [
    { id: "BT1", title: "Colour tokens for charts", decide: "provisional", note: "The palette in dark mode is yours to judge.", min: 300 },
    { id: "BT2", title: "Chart component tests", decide: "accept", min: 240 },
    { id: "BT3", title: "Stats page layout", decide: "provisional", note: "Check the spacing on the phone.", min: 180 },
  ], "Statistics page");
  done("CP", [{ id: "CP1", title: "Empty states", decide: "provisional", note: "The wording of the empty states.", min: 90 }], "Empty states");

  if (o.away) writeAway(turnAway(readAway(), awayUntil("8:00")));
  return root;
}

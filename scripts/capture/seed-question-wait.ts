// Identical three-question fixtures for the all-answers barrier, using only temporary projects.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-question-wait.ts <data dir>");
const projects = ["wait", "answered"].map(id => {
  const root = join(dir, id); mkdirSync(root, { recursive: true });
  const st = ProjectStore.init(root, { id, name: "Questions", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Choices", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "Q1", title: "Choose", goal: "Save each answer; continue when every question is resolved.", acceptance: [] }] });
  approveQueue(st, "Q");
  const session = newId();
  st.writeSession({ protocol: 1, id: session, project: id, title: "Test worker", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: "2026-11-01T12:00:00.000Z", queue: "Q" });
  st.writeSession({ protocol: 1, id: "user", project: id, role: "user", runtime: "external", cwd: root, launched_by: "external", created_at: "2026-11-01T12:00:00.000Z" });
  let tick = 0;
  const emit = (body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: new Date(Date.parse("2026-11-01T12:01:00Z") + tick++ * 1000).toISOString(), session, ...body } as Event);
  emit({ type: "step.started", queue: "Q", step: "Q1" });
  for (const [qid, text, options] of [
    ["q1", "Which layout should we use?", ["A compact list", "A grid"]],
    ["q2", "Which colour should we use?", ["Blue", "Green"]],
    ["q3", "Which notification sound should we use?", ["A quiet chime that stays short and easy to distinguish from other notifications", "No sound"]],
  ] as const) emit({ type: "question.asked", queue: "Q", step: "Q1", qid, text, options, recommended: options[0], can_continue: true });
  emit({ type: "answer.given", session: "user", qid: "q2", text: "Blue", continue: true });
  emit({ type: "answer.given", session: "user", qid: "q1", text: "A compact list", continue: true });
  if (id === "answered") emit({ type: "answer.given", session: "user", qid: "q3", text: "No sound", continue: true });
  return { id, root };
});
writeRegistry({ protocol: 1, projects });

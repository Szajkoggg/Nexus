// The same two open questions for desktop and phone option captures. No real runtime or project data.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-question-options.ts <data dir>");
const root = join(dir, "options");
mkdirSync(root, { recursive: true });
const st = ProjectStore.init(root, { id: "options", name: "Options", root });
writeRegistry({ protocol: 1, projects: [{ id: "options", root }] });
st.writeQueue({ protocol: 1, id: "Q", title: "Question options", revision: 1, status: "proposed", stop_conditions: [], checks: [],
  steps: [{ id: "Q1", title: "Choose", goal: "Answer each question separately.", acceptance: [] }] });
approveQueue(st, "Q");
const session = newId(), at = "2026-11-01T12:00:00.000Z";
st.writeSession({ protocol: 1, id: session, project: "options", title: "Options worker", role: "worker", runtime: "external", cwd: root, launched_by: "external", created_at: at, queue: "Q" });
const emit = (body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at, session, ...body } as Event);
emit({ type: "step.started", queue: "Q", step: "Q1" });
emit({ type: "question.asked", queue: "Q", step: "Q1", qid: "q1", text: "Which layout should we use?", can_continue: false,
  options: ["Keep the compact list with the complete description visible on every screen", "Use a grid"],
  recommended: "Keep the compact list with the complete description visible on every screen" });
emit({ type: "question.asked", queue: "Q", step: "Q1", qid: "q2", text: "Do you accept the screen design?", can_continue: false,
  options: ["Accept the design and screens", "Revise the spacing and keep the full option text readable on a narrow screen"], recommended: "Accept the design and screens" });

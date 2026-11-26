// Two identical test projects so each viewport starts its own held fake worker, on both sides of the capture.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, updateSettings, writeRegistry } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-run-controls.ts <data dir>");
const projects = ["desktop", "phone"].map((id) => {
  const root = join(dir, id);
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id, name: "Demo app", root });
  updateSettings(store, { orchestrator: { notify: false } });
  store.writeQueue({ protocol: 1, id: "RUN", title: "Update the settings page", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: "RUN1", title: "Update the settings", goal: "FAKE: slow", acceptance: [] }] });
  approveQueue(store, "RUN");
  return { id, root };
});
writeRegistry({ protocol: 1, projects });

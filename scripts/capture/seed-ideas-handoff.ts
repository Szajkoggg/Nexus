// IC1 handoff preview: the older date is fully confirmed; the newer date has proposed linked work.
import "./seed-ideas-corrections.ts";
import { join } from "node:path";
import { ProjectStore, changeIdeaStatus, ideaStatuses, loadProjectState } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const store = new ProjectStore(join(process.argv[2]!, "demo/.nexus"));
changeIdeaStatus(store, { operation: "confirm", request_id: "fixture-confirm", revision: ideaStatuses(store, loadProjectState(store)).revision,
  ref: "docs/ideas/chat-improvements.md#2026-11-14", reason: "Reviewed the complete dated decision against CH2." });

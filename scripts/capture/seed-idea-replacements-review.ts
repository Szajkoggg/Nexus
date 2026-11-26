// Identical effective decisions for before/after pictures; the old UI still incorrectly shows B, B, no target.
import "./seed-idea-replacements.ts";
import { join } from "node:path";
import { ProjectStore, loadProjectState } from "@nexus/protocol";
import { ideaStatuses } from "../../packages/protocol/src/ideas-read.ts";
import { changeIdeaStatus } from "../../packages/protocol/src/idea-status-actions.ts";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const store = new ProjectStore(join(process.argv[2]!, "demo/.nexus"));
for (const [date, operation] of [["11", "reopen"], ["12", "replace"], ["13", "replace"]]) {
  changeIdeaStatus(store, { revision: ideaStatuses(store, loadProjectState(store)).revision, request_id: `fixture-${date}`, operation,
    ref: `docs/ideas/replacement-examples.md#2026-11-${date}`, reason: "Explicit user decision in the synthetic fixture.",
    ...(operation === "replace" ? { target: "docs/ideas/choice-c.md#2026-11-15" } : {}) });
}

// A project that has never matched a suggestion: no legacy match file and no inferred reference.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, writeRegistry } from "@nexus/protocol";

const root = join(process.argv[2]!, "demo");
mkdirSync(join(root, "docs/ideas"), { recursive: true });
const store = ProjectStore.init(root, { id: "demo", name: "Unmatched fixture", root, orchestrator: { session: null } });
store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
writeFileSync(join(root, "docs/ideas/choice.md"), "# A dated choice\n\n**Summary:** An independent choice.\n\n## Decided\n\n### 2026-11-15\n\n- Keep this choice.\n\n## Open\n\n- What comes next?\n");
store.writeQueue({ protocol: 1, id: "Q", title: "Unlinked work", revision: 1, status: "proposed", review_level: 2,
  stop_conditions: [], checks: [], approvals: [], withdrawals: [], history: [], changes: [],
  steps: [{ id: "Q1", title: "Work", goal: "Synthetic fixture", acceptance: ["Done"] }],
  created_at: "2026-11-16T08:00:00.000Z", updated_at: "2026-11-16T08:00:00.000Z" });

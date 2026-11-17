// Queue-less replacement cases for IC4 round 2. Only the capture runner's temporary project is written.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, writeRegistry } from "@nexus/protocol";

const root = join(process.argv[2]!, "demo");
mkdirSync(join(root, "docs/ideas"), { recursive: true });
const store = ProjectStore.init(root, { id: "demo", name: "Replacement fixture", root, orchestrator: { session: null } });
store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
for (const target of ["b", "c"]) writeFileSync(join(root, `docs/ideas/choice-${target}.md`), `# Choice ${target.toUpperCase()}\n\n**Area:** dashboard\n\n## Decided\n\n### 2026-11-15\n\n- Replacement ${target.toUpperCase()}.\n`);
writeFileSync(join(root, "docs/ideas/replacement-examples.md"), `# Replacement examples

**Summary:** Three dates with no linked queues.
**Area:** dashboard

## Decided

### 2026-11-11

**Replaced by:** docs/ideas/choice-b.md#2026-11-15
- Reopen the decision previously replaced by B.

### 2026-11-12

**Replaced by:** docs/ideas/choice-b.md#2026-11-15
- Replace the old B target with C.

### 2026-11-13

- Replace with C without a Markdown marker.
`);

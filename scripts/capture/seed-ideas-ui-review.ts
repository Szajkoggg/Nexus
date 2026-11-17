// The accepted correction mockup already has IO/ST2 removed; MT's replacement is still a draft.
import "./seed-ideas-ui.ts";
import { join } from "node:path";
import { ProjectStore, loadProjectState } from "@nexus/protocol";
import { ideaLinks } from "../../packages/protocol/src/ideas-read.ts";
import { changeIdeaLinks } from "../../packages/protocol/src/idea-link-actions.ts";

const store = new ProjectStore(join(process.argv[2]!, "demo/.nexus"));
for (const queue of ["IO", "ST2"]) {
  const links = ideaLinks(store, loadProjectState(store));
  const origin = links.items.find((r) => r.origin === "match" && r.queue === queue && r.ref === "docs/ideas/tags.md#2026-11-14")!;
  changeIdeaLinks(store, { revision: links.revision, request_id: `fixture-remove-${queue}`, operation: "remove", origin: origin.id,
    reason: queue === "IO" ? "Context reference only." : "Tags were delivered by FB." });
}

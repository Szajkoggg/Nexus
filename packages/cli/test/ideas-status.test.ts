// `nexus ideas status` (queue ND): a short summary by default (per note and entry the reference, the effective
// decision, the linked queues, the problems), the full JSON with --full, one entry's (or note's) JSON with a reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, changeIdeaStatus, ideaStatuses, loadProjectState, type IdeaStatusesResponse } from "@nexus/protocol";
import { cliOut } from "./run-cli.ts";


function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-ideas-status-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
  mkdirSync(join(root, "docs/ideas"), { recursive: true });
  writeFileSync(join(root, "docs/ideas/tags.md"), "# Tags\n\n## Decided\n\n### 2026-11-14\n\n- **Facets.**\n\n### 2026-11-15\n\n**Replaced by:** docs/ideas/plan.md#2026-11-30\n\n- **Areas.**\n");
  writeFileSync(join(root, "docs/ideas/plan.md"), "# Plan\n\n## Decided\n\n### 2026-11-16\n\n- **Order.**\n");
  // A queue whose source names the first entry: linked work that is not finished.
  store.writeQueue({ protocol: 1, id: "TG", title: "Tags", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    source: ["docs/ideas/tags.md#2026-11-14"], steps: [{ id: "TG1", title: "One", goal: "", acceptance: [] }] });
  changeIdeaStatus(store, { request_id: "drop", revision: ideaStatuses(store, loadProjectState(store)).revision,
    ref: "docs/ideas/plan.md#2026-11-16", operation: "drop", reason: "User dropped it" });
  const run = async (...args: string[]) => {
    try {
      return { ok: true, out: await cliOut(["ideas", "status", ...args], { env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "" }, cwd: root }) };
    } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  return { run };
}

test("nexus ideas status summarizes each note's entries: reference, effective decision, queues, problems", async () => {
  const { run } = setup();
  const r = await run();
  assert.ok(r.ok, r.out);
  const lines = r.out.trimEnd().split("\n");
  assert.equal(lines[0], "3 decided entries in 2 note(s): 1 active, 1 dropped, 1 replaced; 2 with problems; 1 user action(s)");
  assert.match(lines[1]!, /nexus ideas status <file>\.md#<date>.*nexus doc <file>\.md#<date>.*nexus ideas status --full/);
  assert.deepEqual(lines.slice(2), [
    "",
    "docs/ideas/plan.md",
    "  #2026-11-16  dropped; unconfirmed; no queue",
    "",
    "docs/ideas/tags.md",
    "  #2026-11-14  active; unconfirmed; queues TG proposed",
    "    blocked: TG: work is proposed",
    "  #2026-11-15  replaced by docs/ideas/plan.md#2026-11-30; unconfirmed; no queue",
    "    reference: Replacement target is missing: docs/ideas/plan.md#2026-11-30",
  ]);
  assert.doesNotMatch(r.out, /Facets|snapshot/, "no entry's text, no snapshot");
});

test("nexus ideas status --full prints the whole JSON, every snapshot included", async () => {
  const { run } = setup();
  const r = await run("--full");
  assert.ok(r.ok, r.out);
  const body = JSON.parse(r.out) as IdeaStatusesResponse;
  assert.equal(body.entries.length, 3);
  assert.ok(body.entries.some((e) => /Facets/.test(e.snapshot.content)));
  assert.equal(body.history[0]!.reason, "User dropped it");
});

test("nexus ideas status <ref> narrows the JSON to one entry, or to a note; an unknown date lists the note's dates", async () => {
  const { run } = setup();
  const one = await run("plan.md#2026-11-16");
  assert.ok(one.ok, one.out);
  const body = JSON.parse(one.out) as IdeaStatusesResponse;
  assert.deepEqual(body.entries.map((e) => [e.ref, e.disposition]), [["docs/ideas/plan.md#2026-11-16", "dropped"]]);
  assert.deepEqual(body.history.map((h) => h.ref), ["docs/ideas/plan.md#2026-11-16"]);
  const note = JSON.parse((await run("docs/ideas/tags.md")).out) as IdeaStatusesResponse;
  assert.deepEqual(note.entries.map((e) => e.ref), ["docs/ideas/tags.md#2026-11-14", "docs/ideas/tags.md#2026-11-15"]);
  assert.deepEqual(note.history, [], "another note's actions are left out");
  const unknown = await run("tags.md#2026-11-30");
  assert.ok(!unknown.ok);
  assert.match(unknown.out, /docs\/ideas\/tags\.md has no Decided entry #2026-11-30 \(its dates: 2026-11-14, 2026-11-15\)/);
  assert.match((await run("none.md")).out, /no note docs\/ideas\/none\.md with Decided entries/);
  assert.match((await run("tags.md", "--full")).out, /either a reference or --full/);
});

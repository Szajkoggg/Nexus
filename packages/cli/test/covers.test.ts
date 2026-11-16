// `nexus covers` (queue IO): a thinking partner records the note entries its hand-over passes on, among its own events;
// the ideas overview then reads them as handed over. A reference to a missing note or date is refused, and so is any
// session that is not a partner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, projectIdeas } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-covers-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
  mkdirSync(join(root, "docs/ideas"), { recursive: true });
  writeFileSync(join(root, "docs/ideas/tags.md"), "# Tags\n\n## Decided\n\n### 2026-11-14\n\n- **Facets.**\n\n### 2026-11-15\n\n- **Areas.**\n");
  const at = new Date().toISOString();
  store.writeSession({ protocol: 1, id: "c", project: "p", role: "conversation", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, title: "Tags talk" });
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, queue: "Q" });
  const covers = (session: string, ...args: string[]) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [CLI, "covers", ...args], { env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session }, encoding: "utf8", cwd: root, stdio: "pipe" }) };
    } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  return { store, covers };
}

test("a partner's nexus covers goes among its own events, and the overview reads the entries as handed over", () => {
  const { store, covers } = setup();
  const r = covers("c", "tags.md#2026-11-14", "docs/ideas/tags.md#2026-11-14");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /ok: this hand-over covers docs\/ideas\/tags\.md#2026-11-14$/m, "the folder added, the same entry once");
  const events = store.readEvents("c").entries.filter((e) => e.type === "ideas.covered");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.type === "ideas.covered" && events[0]!.refs, ["docs/ideas/tags.md#2026-11-14"]);
  assert.equal(store.readEvents("w").entries.length, 0);

  const ideas = projectIdeas(store, loadProjectState(store));
  const [d14, d15] = ideas.notes[0]!.entries;
  assert.equal(d14!.status, "handed_over");
  assert.deepEqual(d14!.history.map((h) => [h.kind, h.conversation]), [["decided", undefined], ["handed_over", "Tags talk"]]);
  assert.equal(d15!.status, "decided");
});

test("nexus covers refuses an unknown note or date, a bad reference, and any session that is not a partner", () => {
  const { store, covers } = setup();
  for (const [args, text] of [
    [["tags.md#2026-11-30"], /has no Decided entry of 2026-11-30 \(its dates: 2026-11-14, 2026-11-15\)/],
    [["missing.md#2026-11-14"], /there is no note docs\/ideas\/missing\.md/],
    [["tags.md"], /is not a note reference/],
    [[], /nexus covers <file>\.md#<YYYY-MM-DD>/],
  ] as const) {
    const r = covers("c", ...args);
    assert.ok(!r.ok, `refused: ${args.join(" ")}`);
    assert.match(r.out, text);
  }
  const w = covers("w", "tags.md#2026-11-14");
  assert.ok(!w.ok);
  assert.match(w.out, /only a thinking partner/);
  assert.equal(store.readEvents("c").entries.length, 0, "nothing recorded");
});

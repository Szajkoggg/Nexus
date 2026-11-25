// What a revision does with each optional queue field (ACX, S1, S2): a draft sets it, a second changes it, a third
// leaves it out; the result of the third is compared with the "kept / cleared" table of docs/protocol/queues.md ("What
// a revision does with a field its draft leaves out"). Every optional field of queue.yaml is either in the table or
// named among the server's own fields below it, so a new field fails here until the table says what happens to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, QueueFile, applyDraft, approveQueue, isApproved } from "../src/index.ts";

const QUEUES_MD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "protocol", "queues.md");
const HEADING = "**What a revision does with a field its draft leaves out.**";

/** A value to set and another to change it to, for each field a draft may carry (valid for a queue that never ran). */
const VALUES: Record<string, [unknown, unknown]> = {
  description: ["First.", "Second."],
  track: ["one", "two"],
  review_level: [3, 1],
  worktree: ["auto", "../elsewhere"],
  branch: ["nexus/one", "nexus/two"],
  base: ["main", "develop"],
  coding: [true, false],
  maintenance: ["survey", "fix_small"],
  source: [["docs/ideas/plan.md#2026-11-14"], ["docs/ideas/plan.md#2026-11-15"]],
  kind: ["code", "docs"],
  activities: [["feature"], ["bugfix", "test"]],
  area: ["engine", "protocol"],
  size: ["S", "L"],
  origin: ["user", "maintenance"],
  runtime: ["claude", "codex"],
  model: ["haiku", "gpt-6-luna"],
  effort: ["low", "high"],
  fallback: [["wait"], [{ runtime: "claude", model: "haiku" }]],
  stop_conditions: [["A file outside the repository would change."], ["The tests fail twice."]],
  checks: [["npm test"], ["npm run lint"]],
};

/** The table's rows: each field it names with "kept" or "cleared"; the paragraph after it names the server's fields. */
function documented(): { fate: Map<string, string>; server: Set<string>; status: boolean } {
  const text = readFileSync(QUEUES_MD, "utf8").replaceAll("\r\n", "\n");
  const at = text.indexOf(HEADING);
  assert.ok(at >= 0, `queues.md has the paragraph "${HEADING}"`);
  const lines = text.slice(at).split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Field |"));
  const fate = new Map<string, string>();
  let i = start + 2;
  for (; lines[i]?.startsWith("|"); i++) {
    const [fields, left] = lines[i]!.split("|").slice(1, 3).map((c) => c.trim());
    for (const [, name] of fields!.matchAll(/`([a-z_]+)`/g)) fate.set(name!, left!);
  }
  const paragraph = lines.slice(i + 1).join("\n").split("\n\n")[0]!;
  const server = new Set([...paragraph.slice(paragraph.indexOf("What the server writes")).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
  return { fate, server, status: /`status` is the draft's/.test(paragraph) };
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "nexus-revision-fields-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  // Note references need a notes folder with Decided entries of their dates.
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
  mkdirSync(join(root, "docs", "ideas"), { recursive: true });
  writeFileSync(join(root, "docs", "ideas", "plan.md"), "# Plan\n\n## Decided\n\n### 2026-11-14\n\n- **One.**\n\n### 2026-11-15\n\n- **Two.**\n");
  // The areas the drafts name are the project's (Nexus's own kinds, activities and origins need no list).
  const at = new Date().toISOString();
  store.writeTags({ protocol: 1, areas: [{ name: "engine", at }, { name: "protocol", at }], activities: [], renames: [], proposals: [], decisions: [] });
  return store;
}

const STEPS = [{ id: "Q1", title: "One", goal: "Do it.", acceptance: [] }];
const draft = (extra: Record<string, unknown> = {}) => ({ id: "Q", title: "Queue", steps: STEPS, ...extra });
/** A field as the queue holds it, a list's empty default read as none. */
const held = (store: ProjectStore, field: string): unknown => {
  const v = (store.readQueue("Q") as Record<string, unknown>)[field];
  return Array.isArray(v) && !v.length ? undefined : v;
};

test("every optional field of queue.yaml is in the table or among the server's fields, and the table names no other", () => {
  const out = (QueueFile as unknown as { out: { shape: Record<string, unknown> } }).out.shape;
  const required = ["protocol", "id", "title", "steps"];
  const { fate, server, status } = documented();
  assert.ok(status, "the paragraph after the table says what becomes of `status`");
  const named = new Set([...fate.keys(), ...server, "status", ...required]);
  assert.deepEqual(Object.keys(out).filter((k) => !named.has(k)), [], "fields the table does not cover");
  assert.deepEqual([...named].filter((k) => !(k in out)), [], "names in the table that are no queue field");
  assert.deepEqual([...fate.keys()].sort(), Object.keys(VALUES).sort(), "the test covers each row's fields");
  for (const [field, left] of fate) assert.ok(left === "kept" || left === "cleared", `${field}: "${left}"`);
});

test("a revision sets, changes and leaves out each optional field as the queues.md table says", () => {
  const { fate } = documented();
  const seen = new Map<string, string>();
  for (const [field, [first, second]] of Object.entries(VALUES)) {
    const store = project();
    applyDraft(store, draft());
    assert.equal(held(store, field), undefined, `${field}: not set by a draft without it`);
    applyDraft(store, draft({ [field]: first }));
    assert.deepEqual(held(store, field), field === "source" ? [first].flat() : first, `${field}: set by a revision`);
    applyDraft(store, draft({ [field]: second }));
    assert.deepEqual(held(store, field), second, `${field}: changed by a revision`);
    applyDraft(store, draft());
    const left = held(store, field);
    seen.set(field, left === undefined ? "cleared" : (assert.deepEqual(left, second, `${field}: left out, as it was`), "kept"));
  }
  assert.deepEqual(Object.fromEntries(seen), Object.fromEntries([...fate].filter(([k]) => seen.has(k))));
});

test("the maintenance mode: a revision sets it and changes it, each a new revision to approve; left out, it and the approval stay", () => {
  const store = project();
  applyDraft(store, draft());
  approveQueue(store, "Q");
  const approved = () => isApproved(store.readQueue("Q"));
  assert.equal(approved(), true);
  assert.match(applyDraft(store, draft({ maintenance: "survey" })), /updated to revision 2; it needs the user's approval again/);
  assert.equal(store.readQueue("Q").maintenance, "survey");
  assert.equal(approved(), false, "setting the mode needs the user");
  approveQueue(store, "Q");
  assert.match(applyDraft(store, draft({ maintenance: "fix_small" })), /updated to revision 3/);
  assert.equal(store.readQueue("Q").maintenance, "fix_small");
  approveQueue(store, "Q");
  assert.match(applyDraft(store, draft()), /no change to steps, checks or stop conditions: the approval stands/);
  assert.equal(store.readQueue("Q").maintenance, "fix_small");
  assert.equal(approved(), true);
});

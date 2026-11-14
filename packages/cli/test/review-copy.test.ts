// `nexus review add` copies file material into the step's folder in the queue's folder
// (.nexus/queues/<queue>/review/<step>/), as nexus report copies the report: the item names the copy, links stay
// links, and the source (anywhere, e.g. the temporary folder) is left as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, normPath, now } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

/** The first bytes of a PNG of that size: all the CLI reads of it. */
function png(width: number, height: number, mark = 0): Buffer {
  const b = Buffer.alloc(34);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "ascii"); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b[33] = mark;
  return b;
}

function project() {
  const base = mkdtempSync(join(tmpdir(), "nexus-review-copy-"));
  const root = join(base, "project"), outside = join(base, "temp", "nexus-review", "Q1");
  mkdirSync(root); mkdirSync(outside, { recursive: true });
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "external", queue: "Q", cwd: root, launched_by: "external", created_at: now() });
  const nexus = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, NEXUS_SESSION: "w", NEXUS_DIR: st.dir }, encoding: "utf8", stdio: "pipe" });
  const items = () => loadProjectState(st).queues[0]!.steps[0]!.review_items;
  const dir = st.reviewDir("Q", "Q1");
  return { root, outside, st, nexus, items, dir };
}

test("file material is copied into the step's review folder and the item names the copy; a link stays a link", () => {
  const { root, outside, nexus, items, dir } = project();
  assert.equal(normPath(dir), normPath(join(root, ".nexus", "queues", "Q", "review", "Q1")));
  const doc = join(outside, "notes.md"), data = join(outside, "results.json");
  writeFileSync(doc, "# Notes\n"); writeFileSync(data, "{}\n");

  const out = nexus("review", "add", "Q1", doc, data, "https://example.com/artifact", "--label", "Probe");
  assert.match(out, /ok: 3 review item\(s\) for Q\/Q1 \(the files are copied to .*\/\.nexus\/queues\/Q\/review\/Q1\)/);
  const [a, b, c] = items();
  assert.equal(a!.path, normPath(join(dir, "notes.md")));
  assert.equal(b!.path, normPath(join(dir, "results.json")));
  assert.deepEqual([a!.kind, b!.kind, c!.url, c!.path, c!.kind], ["doc", "data", "https://example.com/artifact", undefined, "link"]);
  assert.equal(readFileSync(a!.path!, "utf8"), "# Notes\n");
  assert.ok(existsSync(doc) && existsSync(data), "the sources stay where they were");

  // A keyed picture too: checked as the source, recorded as the copy.
  writeFileSync(join(outside, "tab@492.png"), png(984, 1600));
  assert.match(nexus("review", "add", "Q1", join(outside, "tab@492.png"), "--key", "tab@492", "--role", "result"), /stands alone/);
  assert.equal(items().at(-1)!.path, normPath(join(dir, "tab@492.png")));
});

test("a name already taken: the same content is not copied twice, another file gets -2, an earlier round's copy stays", () => {
  const { outside, nexus, items, dir } = project();
  const pic = join(outside, "tab@492.png");
  writeFileSync(pic, png(984, 1600, 1));
  nexus("review", "add", "Q1", pic, "--key", "tab@492", "--role", "before");
  nexus("review", "add", "Q1", pic, "--key", "tab@492", "--role", "after");
  writeFileSync(pic, png(984, 1600, 2));
  nexus("review", "add", "Q1", pic, "--key", "tab@492", "--role", "after", "--round", "2");
  const paths = items().map((x) => x.path);
  assert.deepEqual(paths, [normPath(join(dir, "tab@492.png")), normPath(join(dir, "tab@492.png")), normPath(join(dir, "tab@492-2.png"))]);
  assert.equal(readFileSync(paths[0]!)[33], 1, "round 1's copy is as it was");
  assert.equal(readFileSync(paths[2]!)[33], 2);
  // A file already in the review folder is taken as it is.
  nexus("review", "add", "Q1", paths[2]!, "--label", "again");
  assert.equal(items().at(-1)!.path, paths[2]);
  assert.deepEqual(readdirSync(dir).sort(), ["tab@492-2.png", "tab@492.png"]);
});

test("a refused command copies nothing: a missing file among several, a folder, a wrong pair", () => {
  const { outside, nexus, items, dir } = project();
  writeFileSync(join(outside, "a.md"), "a\n");
  assert.throws(() => nexus("review", "add", "Q1", join(outside, "a.md"), join(outside, "missing.md")), /no such file/);
  assert.throws(() => nexus("review", "add", "Q1", outside), /not a file/);
  assert.throws(() => nexus("review", "add", "Q1", join(outside, "a.md"), "--before", join(outside, "missing.png")), /no such file/);
  writeFileSync(join(outside, "b.png"), png(984, 1600)); writeFileSync(join(outside, "a.png"), png(780, 1688));
  nexus("review", "add", "Q1", join(outside, "b.png"), "--key", "tab@492", "--role", "before");
  assert.throws(() => nexus("review", "add", "Q1", join(outside, "a.png"), "--key", "tab@492", "--role", "after"), /refused/);
  assert.equal(items().length, 1);
  assert.deepEqual(readdirSync(dir), ["b.png"], "only the accepted picture was copied");
});

// `nexus review add <step> <picture> --key KEY --role ROLE`: checked pairs; and `nexus help review`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, normPath, now } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

/** The first bytes of a PNG of that size: all the CLI reads of it. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "ascii"); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "nexus-keys-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "One", goal: "", acceptance: [] }] });
  st.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "external", queue: "Q", cwd: root, launched_by: "external", created_at: now() });
  const env = { ...process.env, NEXUS_SESSION: "w", NEXUS_DIR: st.dir };
  const nexus = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  const items = () => loadProjectState(st).queues[0]!.steps[0]!.review_items;
  const refused = (args: string[], re: RegExp) => {
    const before = items().length;
    assert.throws(() => nexus(...args), (e: { stderr: string; status: number }) => {
      assert.equal(e.status, 2); assert.match(e.stderr, re); assert.match(e.stderr, /See: nexus help review/); return true;
    });
    assert.equal(items().length, before, "nothing recorded when refused");
  };
  return { root, nexus, items, refused };
}

test("keyed pictures are recorded with key, role, size and round, and paired by key", () => {
  const { root, nexus, items } = project();
  for (const f of ["b", "a", "new", "u1", "u2"]) writeFileSync(join(root, `${f}.png`), png(984, 1600));
  for (const f of ["va", "vb"]) writeFileSync(join(root, `${f}.png`), png(2560, 1600));

  assert.match(nexus("review", "add", "Q1", "b.png", "--key", "waiting-tab@492", "--role", "before", "--label", "Waiting tab, before"),
    /waiting-tab@492 before, 984×1600 px, round 1, for Q\/Q1, waits for its pair/);
  assert.match(nexus("review", "add", "Q1", "a.png", "--key", "waiting-tab@492", "--role", "after"), /compared with its before \(.*b\.png\)/);
  assert.match(nexus("review", "add", "Q1", "va.png", "--key", "rail@1280", "--role", "variant-a"), /waits for its pair/);
  assert.match(nexus("review", "add", "Q1", "vb.png", "--key", "rail@1280", "--role", "variant-b"), /compared with variant-a/);
  assert.match(nexus("review", "add", "Q1", "new.png", "--key", "usage@492", "--role", "result"), /stands alone/);
  // Rounds: an after with no before or mockup pairs with its key's picture of an earlier round (here round 1's result),
  // and a later round's after still pairs with the before.
  assert.match(nexus("review", "add", "Q1", "u1.png", "--key", "usage@492", "--role", "after", "--round", "2"), /round 2, for Q\/Q1, compared with the result of round 1 \(.*new\.png\)/);
  assert.match(nexus("review", "add", "Q1", "u2.png", "--key", "waiting-tab@492", "--role", "after", "--round", "2"), /round 2, for Q\/Q1, compared with its before/);

  const [b, a] = items();
  assert.deepEqual([b!.path, b!.key, b!.role, b!.size, b!.round, b!.label, b!.kind],
    [normPath(join(root, "b.png")), "waiting-tab@492", "before", { width: 984, height: 1600 }, 1, "Waiting tab, before", "image"]);
  assert.deepEqual([a!.role, a!.label, a!.before], ["after", "a.png", undefined]);
  assert.equal(items().at(-1)!.round, 2);
});

test("a wrong pair is refused with the reason and the pointer; nothing is recorded", () => {
  const { root, nexus, refused } = project();
  writeFileSync(join(root, "b390.png"), png(780, 1600)); writeFileSync(join(root, "a.png"), png(984, 1600));
  writeFileSync(join(root, "tall.png"), png(984, 2400)); writeFileSync(join(root, "page.svg"), "<svg/>"); writeFileSync(join(root, "notes.md"), "# x");
  nexus("review", "add", "Q1", "b390.png", "--key", "waiting-tab@390", "--role", "before");
  nexus("review", "add", "Q1", "a.png", "--key", "settings@492", "--role", "mockup");

  refused(["review", "add", "Q1", "a.png", "--key", "waiting-tab@492", "--role", "after"], /has nothing to pair with in Q\/Q1: the step has waiting-tab@390 \(before\), another key/);
  refused(["review", "add", "Q1", "a.png", "--key", "digest@492", "--role", "after"], /the after digest@492 has nothing to pair with .* --role result/);
  refused(["review", "add", "Q1", "tall.png", "--key", "settings@492", "--role", "after"], /984×2400 px, its mockup \(.*a\.png\) is 984×1600 px/);
  refused(["review", "add", "Q1", "a.png", "--key", "Settings@492", "--role", "after"], /is not a view key/);
  refused(["review", "add", "Q1", "a.png", "--key", "settings@492"], /missing --role/);
  refused(["review", "add", "Q1", "a.png", "--role", "after"], /missing --key/);
  refused(["review", "add", "Q1", "a.png", "--key", "settings@492", "--role", "later"], /--role is one of before, mockup, after/);
  refused(["review", "add", "Q1", "a.png", "b390.png", "--key", "settings@492", "--role", "result"], /exactly one picture/);
  refused(["review", "add", "Q1", "a.png", "--key", "settings@492", "--role", "after", "--before", "b390.png"], /--before is for pictures without a key/);
  refused(["review", "add", "Q1", "page.svg", "--key", "page@492", "--role", "result"], /cannot read the pixel size/);
  refused(["review", "add", "Q1", "notes.md", "--key", "notes@492", "--role", "result"], /an image or a sheet/);
});

test("nexus help review prints the standard; nexus help lists the topics; an unknown topic is refused", () => {
  const { nexus } = project();
  const text = nexus("help", "review");
  for (const part of ["FORMATS", "VIEW KEYS", "ROLES", "PAIRING", "ROUNDS", "CAPTURES", "THE PROCESS", "THE CAPTURE TOOL", "waiting-tab@492", "Fixed-viewport"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(nexus("help"), /Topics \(nexus help <topic>\):\r?\n  review /);
  assert.match(nexus("--help"), /nexus help \[<topic>\]/);
  assert.throws(() => nexus("help", "nope"), /no help topic "nope" \(topics: review, summaries, questions, refusals, commits\)/);
});

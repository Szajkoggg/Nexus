// `nexus review add <step> <picture> --key KEY --role ROLE`: checked pairs; and `nexus help review`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, normPath, now } from "@nexus/protocol";
import { cliOut } from "./run-cli.ts";


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
  const nexus = async (...args: string[]) => await cliOut([...args], { cwd: root, env });
  const items = () => loadProjectState(st).queues[0]!.steps[0]!.review_items;
  const refused = async (args: string[], re: RegExp) => {
    const before = items().length;
    await assert.rejects(async () => await nexus(...args), (e: { stderr: string; status: number }) => {
      assert.equal(e.status, 2); assert.match(e.stderr, re); assert.match(e.stderr, /See: nexus help review/); return true;
    });
    assert.equal(items().length, before, "nothing recorded when refused");
  };
  return { root, st, nexus, items, refused };
}

test("keyed pictures are recorded with key, role, size and round, and paired by key", async () => {
  const { root, st, nexus, items } = project();
  for (const f of ["b", "a", "new", "u1", "u2"]) writeFileSync(join(root, `${f}.png`), png(984, 1600));
  for (const f of ["va", "vb"]) writeFileSync(join(root, `${f}.png`), png(2560, 1600));

  assert.match(await nexus("review", "add", "Q1", "b.png", "--key", "waiting-tab@492", "--role", "before", "--label", "Waiting tab, before"),
    /waiting-tab@492 before, 984×1600 px, round 1, for Q\/Q1, waits for its pair/);
  assert.match(await nexus("review", "add", "Q1", "a.png", "--key", "waiting-tab@492", "--role", "after"), /compared with its before \(.*b\.png\)/);
  assert.match(await nexus("review", "add", "Q1", "va.png", "--key", "rail@1280", "--role", "variant-a"), /waits for its pair/);
  assert.match(await nexus("review", "add", "Q1", "vb.png", "--key", "rail@1280", "--role", "variant-b"), /compared with variant-a/);
  assert.match(await nexus("review", "add", "Q1", "new.png", "--key", "usage@492", "--role", "result"), /stands alone/);
  // Rounds: an after with no before or mockup pairs with its key's picture of an earlier round (here round 1's result),
  // and a later round's after still pairs with the before.
  assert.match(await nexus("review", "add", "Q1", "u1.png", "--key", "usage@492", "--role", "after", "--round", "2"), /round 2, for Q\/Q1, compared with the result of round 1 \(.*new\.png\)/);
  assert.match(await nexus("review", "add", "Q1", "u2.png", "--key", "waiting-tab@492", "--role", "after", "--round", "2"), /round 2, for Q\/Q1, compared with its before/);

  const [b, a] = items();
  assert.deepEqual([b!.path, b!.key, b!.role, b!.size, b!.round, b!.label, b!.kind],
    [normPath(join(st.reviewDir("Q", "Q1"), "b.png")), "waiting-tab@492", "before", { width: 984, height: 1600 }, 1, "Waiting tab, before", "image"]);
  assert.deepEqual([a!.role, a!.label, a!.before], ["after", "a.png", undefined]);
  assert.equal(items().at(-1)!.round, 2);
});

test("a wrong pair is refused with the reason and the pointer; nothing is recorded", async () => {
  const { root, nexus, refused } = project();
  writeFileSync(join(root, "b390.png"), png(780, 1600)); writeFileSync(join(root, "a.png"), png(984, 1600));
  writeFileSync(join(root, "tall.png"), png(984, 2400)); writeFileSync(join(root, "page.svg"), "<svg/>"); writeFileSync(join(root, "notes.md"), "# x");
  await nexus("review", "add", "Q1", "b390.png", "--key", "waiting-tab@390", "--role", "before");
  await nexus("review", "add", "Q1", "a.png", "--key", "settings@492", "--role", "mockup");

  await refused(["review", "add", "Q1", "a.png", "--key", "waiting-tab@492", "--role", "after"], /has nothing to pair with in Q\/Q1: the step has waiting-tab@390 \(before\), another key/);
  await refused(["review", "add", "Q1", "a.png", "--key", "digest@492", "--role", "after"], /the after digest@492 has nothing to pair with .* --role result/);
  await refused(["review", "add", "Q1", "tall.png", "--key", "settings@492", "--role", "after"], /984×2400 px, its mockup \(.*a\.png\) is 984×1600 px/);
  await refused(["review", "add", "Q1", "a.png", "--key", "Settings@492", "--role", "after"], /is not a view key/);
  await refused(["review", "add", "Q1", "a.png", "--key", "settings@492"], /missing --role/);
  await refused(["review", "add", "Q1", "a.png", "--role", "after"], /missing --key/);
  await refused(["review", "add", "Q1", "a.png", "--key", "settings@492", "--role", "later"], /--role is one of before, mockup, after/);
  await refused(["review", "add", "Q1", "a.png", "b390.png", "--key", "settings@492", "--role", "result"], /exactly one picture/);
  await refused(["review", "add", "Q1", "a.png", "--key", "settings@492", "--role", "after", "--before", "b390.png"], /--before is for pictures without a key/);
  await refused(["review", "add", "Q1", "page.svg", "--key", "page@492", "--role", "result"], /cannot read the pixel size/);
  await refused(["review", "add", "Q1", "notes.md", "--key", "notes@492", "--role", "result"], /an image or a sheet/);
});

test("nexus help review prints the standard; nexus help lists the topics; an unknown topic is refused", async () => {
  const { nexus } = project();
  const text = await nexus("help", "review");
  for (const part of ["FORMATS", "VIEW KEYS", "ROLES", "PAIRING", "ROUNDS", "CAPTURES", "THE PROCESS", "THE CAPTURE TOOL", "waiting-tab@492", "Fixed-viewport"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(await nexus("help"), /Topics \(nexus help <topic>\):\r?\n  review /);
  assert.match(await nexus("--help"), /nexus help \[<topic>\]/);
  await assert.rejects(async () => await nexus("help", "nope"), /no help topic "nope" \(topics: review, summaries, context, questions, refusals, commits, tests\)/);
});

// The documents split by topic (docs/doc-split-plan.md; PROTOCOL.md and DESIGN.md): the index lists every topic file and only existing ones, no
// relative link or anchor under docs/ is broken, and a topic file over about 40 KB is warned about (never failed). The
// checks (scripts/doc-layout.ts) run on faulty examples first, then on the real files. The text-only-moved proof of a
// split is scripts/check-doc-split.ts, against the commit the split began from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brokenLinks, contentsProblems, largeTopics, SPLITS, TOPIC_WARN_BYTES } from "../doc-layout.ts";
import { differences } from "../check-doc-split.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const split = { index: "docs/PROTOCOL.md", dir: "docs/protocol" };
const index = (...files: string[]) => `# Nexus protocol\n\n## Contents\n\n${files.map((f) => `- [${f}](protocol/${f}): x.`).join("\n")}\n\n## Later\n`;

// ---------------------------------------------------------------- the checks, on faulty examples

test("the contents must list every topic file", () => {
  assert.deepEqual(contentsProblems(split, index("a.md", "b.md"), ["a.md", "b.md"]), []);
  assert.deepEqual(contentsProblems(split, index("a.md"), ["a.md", "b.md"]), ["docs/PROTOCOL.md: Contents does not list docs/protocol/b.md"]);
});

test("the contents must list only files that exist", () => {
  assert.deepEqual(contentsProblems(split, index("a.md", "gone.md"), ["a.md"]), ["docs/PROTOCOL.md: Contents lists docs/protocol/gone.md, which does not exist"]);
});

test("a link below the contents does not count as listed, and an index without contents fails", () => {
  const late = "# T\n\n## Contents\n\n- [a](protocol/a.md)\n\n## Other\n\n[b](protocol/b.md)\n";
  assert.deepEqual(contentsProblems(split, late, ["a.md", "b.md"]), ["docs/PROTOCOL.md: Contents does not list docs/protocol/b.md"]);
  assert.deepEqual(contentsProblems(split, "# T\n", ["a.md"]), ['docs/PROTOCOL.md has no "## Contents" section']);
});

test("a broken file link and a broken anchor are found, a good one and code are not", () => {
  const files = new Map([
    ["docs/protocol/a.md", "# A\n\n## Local thing\n\n[ok](b.md#the-b-section) [self](#local-thing) [file](b.md) [up](../PROTOCOL.md)\n"],
    ["docs/protocol/b.md", "# B\n\n## The `b` section\n"],
    ["docs/PROTOCOL.md", "# P\n"],
  ]);
  assert.deepEqual(brokenLinks(files, () => false), []);
  const bad = new Map(files);
  bad.set("docs/protocol/a.md", "# A\n\n[x](b.md#no-such) [y](c.md) [z](#nowhere)\n\n```\n[in code](missing.md)\n```\n\nand `[inline](missing.md)`, [web](https://example.org/x.md)\n");
  assert.deepEqual(brokenLinks(bad, () => false), [
    "docs/protocol/a.md:3: b.md#no-such has no heading no-such in docs/protocol/b.md",
    "docs/protocol/a.md:3: c.md names a file that does not exist (docs/protocol/c.md)",
    "docs/protocol/a.md:3: #nowhere has no heading nowhere in docs/protocol/a.md",
  ]);
  assert.deepEqual(brokenLinks(new Map([["docs/x.md", "[pic](ux/p.png)"]]), (p) => p === "docs/ux/p.png"), []);
});

test("a repeated heading's anchors get a number, as on GitHub", () => {
  const files = new Map([["docs/a.md", "# A\n\n## Same\n\n## Same\n\n[1](#same) [2](#same-1) [3](#same-2)\n"]]);
  assert.deepEqual(brokenLinks(files, () => false), ["docs/a.md:7: #same-2 has no heading same-2 in docs/a.md"]);
});

test("a topic file over 40 KB is warned about, the known one says so", () => {
  const sizes = new Map([["docs/protocol/ok.md", TOPIC_WARN_BYTES], ["docs/protocol/big.md", TOPIC_WARN_BYTES + 1024], ["docs/protocol/api.md", 46 * 1024]]);
  assert.deepEqual(largeTopics(sizes), [
    "docs/protocol/big.md is 41 KB: split it along its headings, and list the parts in the Contents",
    "docs/protocol/api.md is 46 KB (a known exception: one section)",
  ]);
});

test("the proof that a split only moved text finds a rewritten, a dropped and an added line", () => {
  const original = "# P\n\nIntro.\n\n## One\n\nA line [with a link](x.md) and \"Two\".\n\n## Two\n\nSecond.\n";
  const idx = "# P\n\nIntro.\n\n## Contents\n\n- [one](protocol/one.md)\n";
  const one = "# One\n\nPart of [the protocol](../PROTOCOL.md).\n\n## One\n\nA line with a link and [\"Two\"](two.md).\n";
  const two = "# Two\n\nSee also: [One](one.md#one).\n\n## Two\n\nSecond.\n";
  assert.deepEqual(differences(original, idx, [one, two]), []);
  assert.equal(differences(original, idx, [one.replace("A line", "Another line"), two]).length, 2);
  assert.equal(differences(original, idx, [one]).length, 2);
  assert.equal(differences(original, idx, [one, two + "\nExtra.\n"]).length, 1);
});

// ---------------------------------------------------------------- the real files

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...markdownFiles(path));
    else if (e.name.endsWith(".md")) out.push(path);
  }
  return out;
}

for (const s of SPLITS) {
  test(`${s.index} lists every topic file of ${s.dir}/ and only existing ones`, () => {
    const topics = readdirSync(join(ROOT, s.dir)).filter((f) => f.endsWith(".md"));
    assert.ok(topics.length > 0, `${s.dir} has topic files`);
    assert.deepEqual(contentsProblems(s, readFileSync(join(ROOT, s.index), "utf8"), topics), []);
  });

  test(`topic files of ${s.dir}/ over 40 KB are warned about`, (t) => {
    const sizes = new Map<string, number>();
    for (const f of readdirSync(join(ROOT, s.dir)).filter((x) => x.endsWith(".md"))) sizes.set(`${s.dir}/${f}`, statSync(join(ROOT, s.dir, f)).size);
    for (const w of largeTopics(sizes)) t.diagnostic(`warning: ${w}`);
  });
}

test("no relative link or anchor under docs/ is broken", () => {
  const files = new Map<string, string>();
  for (const path of markdownFiles("docs")) files.set(path, readFileSync(join(ROOT, path), "utf8"));
  assert.deepEqual(brokenLinks(files, (p) => existsSync(join(ROOT, p))), []);
});

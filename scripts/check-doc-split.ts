// Proves that a document split by topic only moved text (docs/doc-split-plan.md): the lines of the original document, at
// a base commit, are the lines of the index and the topic files together, apart from what a split adds on purpose.
//
//   node scripts/check-doc-split.ts <PROTOCOL|DESIGN> <base commit>
//
// A line is compared without its trailing whitespace, with a heading's `#`s dropped (a moved section changes its level)
// and a Markdown link replaced by its text (a quoted section name becomes a link). Blank lines are not compared. What
// a split adds is ignored: a topic file's title (its first line) and its "Part of" and "See also:" lines, and the index's
// "Contents" section. Every other line must be in both, as many times. Exit code 1 and the differing lines otherwise.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOPIC_DIR: Record<string, string> = { PROTOCOL: "protocol", DESIGN: "design" };

/**
 * Edits of a reference that a split had to make inside moved text (not a move): the original's text, then the new one.
 * Applied to the original before the comparison, so the proof still holds for everything else.
 */
const REFERENCE_REWRITES: [string, string][] = [["nexus doc docs/DESIGN.md#Static analysis", "nexus doc docs/design/checks.md#Static analysis"]];

function normalize(line: string): string {
  return line
    .replace(/\s+$/, "")
    .replace(/^#{1,6} /, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function count(lines: string[], into: Map<string, number>, sign: 1 | -1): void {
  for (const line of lines) {
    const n = normalize(line);
    if (n === "") continue;
    into.set(n, (into.get(n) ?? 0) + sign);
  }
}

/** The lines of an index file without its "Contents" section (up to the next level-2 heading). */
export function withoutContents(text: string): string[] {
  const out: string[] = [];
  let skipping = false;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) skipping = line === "## Contents";
    if (!skipping) out.push(line);
  }
  return out;
}

/** The lines of a topic file without what a split adds: its title, the "Part of" line and the "See also:" lines. */
export function withoutAdditions(text: string): string[] {
  const lines = text.split("\n");
  return lines.slice(1).filter((l) => !/^Part of \[/.test(l) && !/^See also: /.test(l));
}

export function differences(original: string, index: string, topics: string[]): string[] {
  const seen = new Map<string, number>();
  count(original.split("\n"), seen, 1);
  count(withoutContents(index), seen, -1);
  for (const t of topics) count(withoutAdditions(t), seen, -1);
  return [...seen].filter(([, n]) => n !== 0).map(([line, n]) => `${n > 0 ? "missing" : "added"} ${Math.abs(n)}x: ${line.slice(0, 160)}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  const [doc, base] = process.argv.slice(2);
  const dir = doc ? TOPIC_DIR[doc] : undefined;
  if (!doc || !base || !dir) {
    console.error("usage: node scripts/check-doc-split.ts <PROTOCOL|DESIGN> <base commit>");
    process.exit(2);
  }
  const original = execFileSync("git", ["show", `${base}:docs/${doc}.md`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
  const index = readFileSync(`docs/${doc}.md`, "utf8");
  const files = readdirSync(join("docs", dir)).filter((f) => f.endsWith(".md")).sort();
  const topics = files.map((f) => readFileSync(join("docs", dir, f), "utf8"));
  const rewritten = REFERENCE_REWRITES.reduce((text, [from, to]) => text.split(from).join(to), original);
  const diff = differences(rewritten, index, topics);
  if (diff.length) {
    console.log(diff.join("\n"));
    console.log(`${diff.length} line(s) differ from ${base}:docs/${doc}.md`);
    process.exit(1);
  }
  console.log(`ok: ${doc}.md at ${base} = the index and ${files.length} topic files, only moved`);
}

// Proves that a document split by topic only moved text (docs/doc-split-plan.md): the lines of the original document, at
// a base commit, are the lines of the index and the topic files together, apart from what a split adds on purpose.
//
//   node scripts/check-doc-split.ts <PROTOCOL|DESIGN> <base commit>
//   node scripts/check-doc-split.ts --topic <base commit> <topic file at the base> <new file> <new file>...
//
// The second form proves the split of one topic file that grew too large: the file at the base commit is the new files
// together (its title is dropped; each new file's title, "Part of" and "See also:" lines are additions).
//
// A line is compared without its trailing whitespace, with a heading's `#`s dropped (a moved section changes its level)
// and a Markdown link replaced by its text (a quoted section name becomes a link). Blank lines are not compared. What
// a split adds is ignored: a topic file's title (its first line) and its "Part of" and "See also:" lines, and the index's
// "Contents" section. Every other line must be in both, as many times. Exit code 1 and the differing lines otherwise.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SPLITS } from "./doc-layout.ts";

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
function withoutContents(text: string): string[] {
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
function withoutAdditions(text: string): string[] {
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

/** A topic file split into several: its lines (without its title) are the new files' lines, apart from their additions. */
export function topicDifferences(original: string, topics: string[]): string[] {
  return differences(original.split("\n").slice(1).join("\n"), "", topics);
}

/** A file as it was at a commit, with LF line ends. */
function atCommit(commit: string, path: string): string {
  return execFileSync("git", ["show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
}

/** Prints the differences and exits 1, or prints `ok` and exits 0. */
function report(diff: string[], before: string, ok: string): never {
  if (diff.length) {
    console.log(diff.join("\n"));
    console.log(`${diff.length} line(s) differ from ${before}`);
    process.exit(1);
  }
  console.log(`ok: ${ok}, only moved`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--topic") {
    const [, base, old, ...news] = args;
    if (!base || !old || news.length < 2) {
      console.error("usage: node scripts/check-doc-split.ts --topic <base commit> <topic file at the base> <new file> <new file>...");
      process.exit(2);
    }
    const diff = topicDifferences(atCommit(base, old), news.map((f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
    report(diff, `${base}:${old}`, `${old} at ${base} = ${news.join(", ")}`);
  }
  const [doc, base] = args;
  const split = SPLITS.find((s) => s.index === `docs/${doc}.md`);
  if (!doc || !base || !split) {
    console.error("usage: node scripts/check-doc-split.ts <PROTOCOL|DESIGN> <base commit>");
    process.exit(2);
  }
  const original = atCommit(base, `docs/${doc}.md`);
  const index = readFileSync(split.index, "utf8");
  const files = readdirSync(split.dir).filter((f) => f.endsWith(".md")).sort();
  const topics = files.map((f) => readFileSync(join(split.dir, f), "utf8"));
  const rewritten = REFERENCE_REWRITES.reduce((text, [from, to]) => text.split(from).join(to), original);
  report(differences(rewritten, index, topics), `${base}:docs/${doc}.md`, `${doc}.md at ${base} = the index and ${files.length} topic files`);
}

// The rule that every script writing NEXUS_HOME's files calls the guard (scripts/temp-home.ts, requireTempHome), checked
// by scripts/test/temp-home.test.ts on a faulty example and on the repository's scripts (queue NHG). Pure functions
// over the files' texts.
//
// A script writes NEXUS_HOME when its code calls one of the protocol's writers of NEXUS_HOME's files, or builds a path
// in it (nexusHome()), or imports, by a relative path inside scripts/, a script that does (transitively: an import's
// body runs before the importer's, so the imported script has to guard itself; the importer calls the guard too).
// Such a script calls requireTempHome(): before its first write, and again after every `process.env.NEXUS_HOME =`
// that comes before a write. A write the rule leaves out on purpose is an exception, by file and call, with why.

/** The protocol's functions that write NEXUS_HOME's files (packages/protocol/src/store.ts, actions.ts), and nexusHome(). */
const HOME_WRITERS = [
  "writeRegistry", "updateGlobalSettings", "writeGlobalSettings", "ensureGlobalSettings", "writeAway", "appendTurn",
  "writeCapacity", "writeUsage", "appendServerSpeed", "nexusHome",
] as const;

export interface HomeWriteException { file: string; call: string; why: string }

/** The writes to the real NEXUS_HOME scripts make on purpose. */
export const HOME_WRITE_EXCEPTIONS: readonly HomeWriteException[] = [
  {
    file: "scripts/server-speed.ts", call: "appendServerSpeed",
    why: "the run's result goes to the real <NEXUS_HOME>/benchmarks/server-speed.jsonl on purpose: the global Stats view reads it (the file is taken before NEXUS_HOME points at a configuration's folder)",
  },
];

/** The text without its comments (line and block). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const writerCall = new RegExp(`\\b(?:${HOME_WRITERS.join("|")})\\s*\\(`, "g");
const indexes = (re: RegExp, text: string) => [...text.matchAll(new RegExp(re.source, "g"))].map((m) => m.index);

/** The relative imports of a file's code (static, side-effect and dynamic), as written. */
function relativeImports(c: string): string[] {
  const re = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*)(["'])(\.{1,2}\/[^"'\n]+)\1/g;
  return [...c.matchAll(re)].map((m) => m[2]!);
}

/** `from` (a file's path, forward slashes) joined with a relative import. */
function resolveImport(from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/**
 * What is wrong with these scripts (paths relative to the repository, forward slashes): a script that writes NEXUS_HOME
 * (directly or through its relative imports) and does not call the guard, calls it only after a write, or sets
 * NEXUS_HOME and writes without calling it again; an exception whose call is no longer there. Empty when all is right.
 */
export function homeGuardFindings(files: readonly { path: string; text: string }[], exceptions: readonly HomeWriteException[] = HOME_WRITE_EXCEPTIONS): string[] {
  const findings: string[] = [];
  const codes = new Map(files.map((f) => [f.path, code(f.text)]));
  const direct = new Map<string, number[]>();
  for (const [path, c0] of codes) {
    let c = c0;
    for (const e of exceptions.filter((x) => x.file === path)) {
      const re = new RegExp(`\\b${e.call}\\s*\\(`, "g");
      if (!new RegExp(re.source).test(c)) findings.push(`${path}: the exception for ${e.call}() is listed, but the file no longer calls it: take it off the list`);
      c = c.replace(re, "excepted(");
    }
    codes.set(path, c);
    const writes = indexes(writerCall, c);
    if (writes.length) direct.set(path, writes);
  }
  for (const e of exceptions) if (!codes.has(e.file)) findings.push(`${e.file}: listed as an exception, but no such script`);

  // Transitively: a script writes when it imports one that does.
  const writing = new Map<string, string>();
  for (const path of direct.keys()) writing.set(path, "calls a writer of NEXUS_HOME's files");
  for (let changed = true; changed;) {
    changed = false;
    for (const [path, c] of codes) {
      if (writing.has(path)) continue;
      const via = relativeImports(c).map((s) => resolveImport(path, s)).find((p) => writing.has(p));
      if (via) { writing.set(path, `imports ${via}, which writes NEXUS_HOME's files`); changed = true; }
    }
  }

  for (const [path, why] of writing) {
    const c = codes.get(path)!;
    const guards = indexes(/\brequireTempHome\s*\(/, c);
    if (!guards.length) { findings.push(`${path}: ${why}, but does not call requireTempHome() (scripts/temp-home.ts)`); continue; }
    const writes = direct.get(path) ?? [];
    if (writes.length && guards[0]! > writes[0]!) findings.push(`${path}: writes NEXUS_HOME's files before it calls requireTempHome()`);
    for (const set of indexes(/\bprocess\.env\.NEXUS_HOME\s*=(?!=)/, c)) {
      const next = writes.find((w) => w > set);
      if (next !== undefined && !guards.some((g) => g > set && g < next)) findings.push(`${path}: sets NEXUS_HOME and writes without calling requireTempHome() again`);
    }
  }
  return findings.sort();
}

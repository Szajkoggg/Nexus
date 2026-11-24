// The code-health trend numbers: the same five measures of the whole code base, counted the same way on every run, so
// that one run can be compared with the last (queue CHT, the nexus-code-health template).
//
//   node scripts/code-health-metrics.ts
//
// Prints one JSON object to stdout and writes no file. Its first five keys are the metrics' names, counted on the
// sources without the tests; `details` holds the breakdowns, the ten largest source files and the tests' numbers.
//
// Method (change it only together with the numbers' history, since a new method breaks the trend):
// - Files: what `git ls-files` lists under packages/, apps/ and scripts/ with the extension .ts, .tsx, .mts, .cts,
//   .js, .mjs or .cjs, read from the working tree. A test file is one with a folder named test, tests or __tests__ in
//   its path, or a name ending in .test.* or .spec.*; every other file is a source.
// - code.largest_file_kb: the largest source file's size in bytes / 1024, rounded to one decimal.
// - code.duplication_pct: duplicated significant lines / all significant lines * 100, rounded to two decimals. A
//   significant line is a line with its whitespace trimmed and runs of whitespace made one space, left out when it is
//   empty, a comment line (starting with //, /* or *), an import line (starting with `import ` or `} from `), or has
//   no letter or digit (a lone `});`). Every run of WINDOW (6) consecutive significant lines of a file is a block; a
//   block whose text occurs twice or more (in the same file or another) makes each of its lines duplicated. Sources
//   and tests are compared each among themselves.
// - code.type_escapes: in the syntax tree (TypeScript's parser, no type checking), every `any` type, every type
//   assertion (`x as T` or `<T>x`) except `as const`, and every non-null assertion expression (`x!`). Definite
//   assignment marks (`let x!: T`) and `satisfies` are not counted.
// - code.empty_catches: every `catch` block, and every function given to a `.catch(...)` call, that swallows the
//   error: its body has no throw, no call or `new`, no assignment and no reference to the caught error. So an empty
//   block, one with comments only, or one that only returns a constant or continues counts; one that logs, reports,
//   rethrows or sets a flag does not.
// - code.sync_calls: in apps/server/src (sources only), every call of a function whose name ends in `Sync`. The
//   breakdown: `git` (execSync, execFileSync or spawnSync whose first argument is the literal "git" or a string that
//   starts with "git "), `process` (the other calls of those three), `fs` (every other *Sync call: node:fs and the
//   like). A call through a synchronous wrapper of the code's own (gitinfo.ts's git()) counts once, at the wrapper.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOTS = ["packages/", "apps/", "scripts/"];
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const WINDOW = 6;
const SERVER_RUNTIME = "apps/server/src/";
const PROCESS_CALLS = new Set(["execSync", "execFileSync", "spawnSync"]);

export interface SourceFile { path: string; text: string }
export interface TypeEscapes { any: number; as: number; non_null: number }
export interface SyncCalls { fs: number; process: number; git: number }

/** Whether a repository path (forward slashes) is one of the measured code files. */
export const isCode = (path: string): boolean => ROOTS.some((r) => path.startsWith(r)) && EXTENSIONS.test(path);

/** Whether a repository path is a test file: a test folder in its path, or a .test. / .spec. name. */
export function isTest(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.slice(0, -1).some((p) => p === "test" || p === "tests" || p === "__tests__") || /\.(test|spec)\.[^.]+$/.test(name);
}

const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

/** A line as the duplication count compares it, or undefined when it is not significant. */
export function significant(line: string): string | undefined {
  const s = line.trim().replace(/\s+/g, " ");
  if (s === "" || s.startsWith("//") || s.startsWith("/*") || s.startsWith("*")) return undefined;
  if (s.startsWith("import ") || s.startsWith("} from ")) return undefined;
  if (!/[\p{L}\p{N}]/u.test(s)) return undefined;
  return s;
}

/** Duplicated and all significant lines of a set of files compared among themselves, and the percentage. */
export function duplication(files: readonly SourceFile[], window = WINDOW): { duplicated: number; lines: number; pct: number } {
  const lines = files.map((f) => f.text.split(/\r?\n/).map(significant).filter((l): l is string => l !== undefined));
  const blocks = new Map<string, number>();
  const key = (ls: string[], i: number) => ls.slice(i, i + window).join("\n");
  for (const ls of lines) for (let i = 0; i + window <= ls.length; i++) {
    const k = key(ls, i);
    blocks.set(k, (blocks.get(k) ?? 0) + 1);
  }
  let duplicated = 0;
  let total = 0;
  for (const ls of lines) {
    const marked = new Array<boolean>(ls.length).fill(false);
    for (let i = 0; i + window <= ls.length; i++) {
      if ((blocks.get(key(ls, i)) ?? 0) > 1) marked.fill(true, i, i + window);
    }
    duplicated += marked.filter(Boolean).length;
    total += ls.length;
  }
  return { duplicated, lines: total, pct: total === 0 ? 0 : Math.round((duplicated / total) * 10000) / 100 };
}

function parse(file: SourceFile): ts.SourceFile {
  const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(file.path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, kind);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

const isAsConst = (n: ts.AsExpression) =>
  ts.isTypeReferenceNode(n.type) && ts.isIdentifier(n.type.typeName) && n.type.typeName.text === "const";

/** The `any` types, type assertions (without `as const`) and non-null assertions of a file. */
export function typeEscapes(file: SourceFile): TypeEscapes {
  const out: TypeEscapes = { any: 0, as: 0, non_null: 0 };
  walk(parse(file), (n) => {
    if (n.kind === ts.SyntaxKind.AnyKeyword) out.any++;
    else if (ts.isAsExpression(n) && !isAsConst(n)) out.as++;
    else if (ts.isTypeAssertionExpression(n)) out.as++;
    else if (ts.isNonNullExpression(n)) out.non_null++;
  });
  return out;
}

/** Whether a handler's body only swallows the error (see the method above); `error` is the caught error's name. */
function swallows(body: ts.Node, error: string | undefined): boolean {
  let handles = false;
  walk(body, (n) => {
    if (ts.isThrowStatement(n) || ts.isCallExpression(n) || ts.isNewExpression(n)) handles = true;
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) handles = true;
    else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) handles = true;
    else if (error !== undefined && ts.isIdentifier(n) && n.text === error) handles = true;
  });
  return !handles;
}

const bindingName = (d: ts.VariableDeclaration | ts.ParameterDeclaration | undefined): string | undefined =>
  d && ts.isIdentifier(d.name) ? d.name.text : undefined;

/** The catch blocks and `.catch(...)` handlers of a file that swallow the error. */
export function emptyCatches(file: SourceFile): number {
  let count = 0;
  walk(parse(file), (n) => {
    if (ts.isCatchClause(n)) {
      if (swallows(n.block, bindingName(n.variableDeclaration))) count++;
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch") {
      const handler = n.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && swallows(handler.body, bindingName(handler.parameters[0]))) count++;
    }
  });
  return count;
}

/** The *Sync calls of a file, split into git, other process and file (and other) calls. */
export function syncCalls(file: SourceFile): SyncCalls {
  const out: SyncCalls = { fs: 0, process: 0, git: 0 };
  walk(parse(file), (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    if (!name?.endsWith("Sync")) return;
    if (!PROCESS_CALLS.has(name)) { out.fs++; return; }
    const first = n.arguments[0];
    const text = first && ts.isStringLiteralLike(first) ? first.text : undefined;
    if (text === "git" || text?.startsWith("git ")) out.git++;
    else out.process++;
  });
  return out;
}

const sum = <K extends string>(items: readonly Record<K, number>[], keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, items.reduce((n, item) => n + item[k], 0)])) as Record<K, number>;

/** The ten largest files, largest first, ties by path. */
function largest(files: readonly SourceFile[]): { path: string; kb: number }[] {
  return files
    .map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text, "utf8") }))
    .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 10)
    .map((f) => ({ path: f.path, kb: kb(f.bytes) }));
}

function measure(files: readonly SourceFile[]) {
  const top = largest(files);
  const escapes = sum(files.map(typeEscapes), ["any", "as", "non_null"]);
  const dup = duplication(files);
  return {
    files: files.length,
    largest_file_kb: top[0]?.kb ?? 0,
    largest: top,
    duplication: dup,
    escapes,
    empty_catches: files.reduce((n, f) => n + emptyCatches(f), 0),
  };
}

/** The report for a set of code files (the paths relative to the repository, forward slashes). */
export function report(all: readonly SourceFile[]) {
  const files = [...all].filter((f) => isCode(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = files.filter((f) => !isTest(f.path));
  const tests = files.filter((f) => isTest(f.path));
  const s = measure(sources);
  const t = measure(tests);
  const sync = sum(sources.filter((f) => f.path.startsWith(SERVER_RUNTIME)).map(syncCalls), ["fs", "process", "git"]);
  const total = (e: TypeEscapes) => e.any + e.as + e.non_null;
  return {
    "code.largest_file_kb": s.largest_file_kb,
    "code.duplication_pct": s.duplication.pct,
    "code.type_escapes": total(s.escapes),
    "code.empty_catches": s.empty_catches,
    "code.sync_calls": sync.fs + sync.process + sync.git,
    details: {
      method: { duplication_window: WINDOW, roots: ROOTS, sync_calls_in: SERVER_RUNTIME },
      sources: {
        files: s.files,
        significant_lines: s.duplication.lines,
        duplicated_lines: s.duplication.duplicated,
        type_escapes: s.escapes,
        sync_calls: sync,
        largest: s.largest,
      },
      tests: {
        files: t.files,
        largest_file_kb: t.largest_file_kb,
        duplication_pct: t.duplication.pct,
        significant_lines: t.duplication.lines,
        duplicated_lines: t.duplication.duplicated,
        type_escapes: total(t.escapes),
        type_escapes_by_kind: t.escapes,
        empty_catches: t.empty_catches,
      },
    },
  };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const listed = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const files = listed.split("\0").filter((p) => isCode(p) && existsSync(resolve(root, p))).map((path) => ({ path, text: readFileSync(resolve(root, path), "utf8") }));
  process.stdout.write(`${JSON.stringify(report(files), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

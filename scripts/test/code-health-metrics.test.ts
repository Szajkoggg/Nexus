// The code-health trend numbers (scripts/code-health-metrics.ts): every counting rule on small made-up files, each with
// a case that counts and one that does not, and the report's shape and order on a made-up set of files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { duplication, emptyCatches, isCode, isTest, report, significant, syncCalls, typeEscapes } from "../code-health-metrics.ts";

const ts = (text: string, path = "apps/server/src/x.ts") => ({ path, text });

test("code files: sources and tests are told apart by folder and name", () => {
  assert.equal(isCode("apps/server/src/engine.ts"), true);
  assert.equal(isCode("scripts/capture/open-stats.js"), true);
  assert.equal(isCode("apps/server/src/worker-job.cs"), false);
  assert.equal(isCode("docs/x.ts"), false);
  assert.equal(isTest("apps/server/test/engine.test.ts"), true);
  assert.equal(isTest("apps/web/src/x.spec.tsx"), true);
  assert.equal(isTest("scripts/test/helpers.ts"), true);
  assert.equal(isTest("apps/server/src/check-runs.ts"), false);
  assert.equal(isTest("apps/server/src/testing.ts"), false);
});

test("largest file: the largest source in KB, tests apart, ten at most", () => {
  const files = [
    ts("x".repeat(2048), "apps/a.ts"),
    ts("x".repeat(3000), "apps/test/big.test.ts"),
    ...Array.from({ length: 11 }, (_, i) => ts("y".repeat(100 + i), `packages/p${i}.ts`)),
  ];
  const r = report(files);
  assert.equal(r["code.largest_file_kb"], 2);
  assert.equal(r.details.sources.largest.length, 10);
  assert.equal(r.details.sources.largest.some((f) => f.path.includes("test")), false);
  assert.equal(r.details.tests.largest_file_kb, 2.9);
});

test("duplication: a repeated block of six significant lines counts, five do not", () => {
  const block = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i});`).join("\n");
  const six = duplication([ts(`${block(6, "v")}\nconst a = 1;`), ts(`const b = 2;\n${block(6, "v")}`)]);
  assert.deepEqual(six, { duplicated: 12, lines: 14, pct: 85.71 });
  const five = duplication([ts(`${block(5, "v")}\nconst a = 1;`), ts(`const b = 2;\n${block(5, "v")}`)]);
  assert.deepEqual(five, { duplicated: 0, lines: 12, pct: 0 });
  // Blank, comment, import and punctuation-only lines are left out, so they neither make nor break a block.
  assert.equal(significant("   });"), undefined);
  assert.equal(significant("// a comment"), undefined);
  assert.equal(significant('import { x } from "y";'), undefined);
  assert.equal(significant("  return   a  +  b;"), "return a + b;");
  const spaced = duplication([ts(block(6, "v")), ts(block(6, "v").split("\n").join("\n\n// note\n}\n"))]);
  assert.equal(spaced.duplicated, 12);
});

test("type escapes: any, assertions and non-null assertions count; as const, satisfies and x!: T do not", () => {
  assert.deepEqual(typeEscapes(ts("let a: any = 1; const b = a as string; const c = <number>a; const d = a!.length;")), { any: 1, as: 2, non_null: 1 });
  assert.deepEqual(typeEscapes(ts("const a = [1] as const; const b = { x: 1 } satisfies object; let c!: string; const d = !c;")), { any: 0, as: 0, non_null: 0 });
  assert.deepEqual(typeEscapes(ts("const e = <div>{x!}</div> as unknown;", "apps/web/src/x.tsx")), { any: 0, as: 1, non_null: 1 });
});

test("empty catches: a block or .catch handler that only swallows counts; one that handles does not", () => {
  const swallowing = [
    "try { f(); } catch {}",
    "try { f(); } catch { /* gone */ }",
    "try { f(); } catch { return undefined; }",
    "try { f(); } catch (e) { continue; }",
    "p.catch(() => {});",
    "p.catch(() => undefined);",
    "p.catch(function () { return null; });",
  ];
  for (const text of swallowing) assert.equal(emptyCatches(ts(`for (;;) { ${text} }`)), 1, text);
  const handling = [
    "try { f(); } catch (e) { log(e); }",
    "try { f(); } catch (e) { return String(e); }",
    "try { f(); } catch (e) { if (e) return; }",
    "try { f(); } catch { throw new Error('x'); }",
    "try { f(); } catch { failed = true; }",
    "try { f(); } catch { errors++; }",
    "p.catch((e) => report(e));",
    "p.catch(handler);",
  ];
  for (const text of handling) assert.equal(emptyCatches(ts(`for (;;) { ${text} }`)), 0, text);
});

test("sync calls: *Sync calls split into git, process and fs, only in the server's runtime sources", () => {
  const text = [
    'execFileSync("git", ["status"]);',
    'cp.execSync("git rev-parse HEAD");',
    'spawnSync("powershell", []);',
    'execFileSync(GIT, []);',
    'fs.readFileSync("a");',
    'existsSync("b");',
    'readFile("c"); syncNow(); exec("git status"); const s = x.Sync;',
  ].join("\n");
  assert.deepEqual(syncCalls(ts(text)), { git: 2, process: 2, fs: 2 });
  assert.deepEqual(syncCalls(ts('readFile("c"); exec("git status");')), { git: 0, process: 0, fs: 0 });
  const r = report([
    ts('readFileSync("a");', "apps/server/src/a.ts"),
    ts('readFileSync("a");', "apps/server/test/a.test.ts"),
    ts('readFileSync("a");', "packages/cli/src/a.ts"),
  ]);
  assert.equal(r["code.sync_calls"], 1);
});

test("the report: the five metrics first, the same output for the same files in any order", () => {
  const files = [ts("let a: any;", "apps/server/src/b.ts"), ts("try {} catch {}", "packages/protocol/src/a.ts"), ts("x!;", "apps/web/test/c.test.ts")];
  const r = report(files);
  assert.deepEqual(Object.keys(r), ["code.largest_file_kb", "code.duplication_pct", "code.type_escapes", "code.empty_catches", "code.sync_calls", "details"]);
  assert.equal(r["code.type_escapes"], 1);
  assert.equal(r["code.empty_catches"], 1);
  assert.equal(r.details.tests.type_escapes, 1);
  assert.equal(JSON.stringify(report([...files].reverse())), JSON.stringify(r));
});

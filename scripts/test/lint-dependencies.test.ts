// Compatibility at the actual lint dependency boundaries, including the project-service minimatch call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import type { Program } from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const lintRequire = createRequire(require.resolve("typescript-eslint"));
// Resolve the parser through its declared consumer too, including its public cache-cleanup API.
const { clearCaches, parseForESLint } = lintRequire("@typescript-eslint/parser") as {
  clearCaches: () => void;
  parseForESLint: (source: string, options: { filePath: string; tsconfigRootDir: string;
    projectService: true | { allowDefaultProject: string[] } }) => { services: { program: Program | null } };
};
// Resolve from estree, not the unrelated minimatch used by ESLint itself.
const estreeRequire = createRequire(lintRequire.resolve("@typescript-eslint/typescript-estree"));
const { minimatch } = estreeRequire("minimatch") as { minimatch: (path: string, pattern: string, options: { dot: boolean }) => boolean };

test("estree's minimatch preserves relative path, dot, brace and extglob matching", (t) => {
  const cases: [string, string, boolean][] = [
    ["config.ts", "*.ts", true], [".config.ts", "*.ts", true], ["config.js", "*.ts", false],
    ["config/build.ts", "*.ts", false], ["config/build.ts", "config/*.ts", true],
    ["config/.hidden.ts", "config/*.ts", true], [".config/build.ts", "*/build.ts", true],
    ["config/nested/build.ts", "config/*.ts", false], ["config/view.tsx", "config/*.{ts,tsx}", true],
    ["config/view.js", "config/*.{ts,tsx}", false], ["config/build.ts", "config/@(build|lint).ts", true],
    ["config/other.ts", "config/@(build|lint).ts", false],
  ];
  for (const [path, pattern, expected] of cases) {
    assert.equal(minimatch(path, pattern, { dot: true }), expected, `${path} ~ ${pattern}`);
  }
  assert.equal(minimatch(".config.ts", "*.ts", { dot: false }), false);
  if (process.platform === "win32") assert.equal(minimatch("config\\.hidden.ts", "config/*.ts", { dot: true }), true);
  t.diagnostic(`estree resolves minimatch ${(estreeRequire("minimatch/package.json") as { version: string }).version}; ${cases.length} dot:true cases passed`);
});

test("projectService recognizes TypeScript files and limits its default-project glob allowance", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-lint-deps-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }));
  const source = "export const answer: number = 42;\n";
  for (const file of ["src/main.ts", ".config.ts", "config/.hidden.ts", "other/build.ts"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  const parse = (file: string, allowDefaultProject?: string[]) => {
    clearCaches();
    return parseForESLint(source, { filePath: join(dir, file), tsconfigRootDir: dir,
      projectService: allowDefaultProject ? { allowDefaultProject } : true });
  };
  try {
    for (const [file, allow] of [["src/main.ts", undefined], [".config.ts", ["*.ts"]],
      ["config/.hidden.ts", ["config/*.ts"]]] as const) {
      const parsed = parse(file, allow ? [...allow] : undefined);
      assert.ok(parsed.services.program?.getSourceFile(join(dir, file)), `type-aware program includes ${file}`);
    }
    assert.throws(() => parse("other/build.ts", ["config/*.ts"]), /not found by the project service/);
    assert.throws(() => parse(".config.ts", ["**/*.ts"]), /disallowed '\*\*'/);
    assert.throws(() => parse(".config.ts", ["*"]), /overly wide '\*'/);
  } finally { clearCaches(); }
});

test("the repository's unchanged ESLint configuration still detects TS/TSX files and typed errors", async () => {
  const eslint = new ESLint({ cwd: root });
  const files = ["packages/protocol/src/index.ts", "packages/cli/src/main.ts", "apps/server/src/main.ts", "apps/web/src/main.tsx"];
  for (const file of files) {
    assert.equal(await eslint.isPathIgnored(join(root, file)), false, file);
    const config = await eslint.calculateConfigForFile(join(root, file));
    assert.equal(config.languageOptions.parserOptions.projectService, true, file);
  }
  const results = await eslint.lintText("Promise.resolve(42);\n", { filePath: "apps/server/src/main.ts" });
  assert.equal(results[0]!.fatalErrorCount, 0);
  assert.ok(results[0]!.messages.some((m) => m.ruleId === "@typescript-eslint/no-floating-promises" && m.severity === 2));
  // An ordinary repository file still parses under the same actual configuration.
  const clean = await eslint.lintText(readFileSync(join(root, "apps/server/src/web-static.ts"), "utf8"), { filePath: "apps/server/src/web-static.ts" });
  assert.equal(clean[0]!.errorCount, 0);
});

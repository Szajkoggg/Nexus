// Static analysis detection (static-analysis.ts) on made-up projects: Node with and without ESLint, .NET with and
// without analyzers, Unity; and when the reminder may come again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  STATIC_DECLINE_REST_MS, STATIC_REMIND_EVERY_MS, detectStaticAnalysis, lacksStaticAnalysis, listProjectFiles, projectStaticAnalysis, staticReminderDue,
} from "../src/static-analysis.ts";

/** A project folder with these files (relative path: text). */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-static-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const PKG = JSON.stringify({ name: "x", scripts: { test: "node --test" } });
const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`;

test("Node: an ESLint config, an eslintConfig or a lint script is static analysis; none of them is not", () => {
  const bare = projectStaticAnalysis(project({ "package.json": PKG, "src/a.js": "" }));
  assert.deepEqual(bare, { stacks: ["node"], found: [] });
  assert.equal(lacksStaticAnalysis(bare), true);
  assert.deepEqual(projectStaticAnalysis(project({ "package.json": PKG, "eslint.config.js": "export default []" })).found, ["eslint.config.js: linter config"]);
  assert.deepEqual(projectStaticAnalysis(project({ "package.json": PKG, "web/.eslintrc.json": "{}" })).found, ["web/.eslintrc.json: linter config"]);
  assert.deepEqual(projectStaticAnalysis(project({ "package.json": JSON.stringify({ scripts: { lint: "biome check" } }) })).found, ["package.json: lint script"]);
  assert.deepEqual(projectStaticAnalysis(project({ "package.json": JSON.stringify({ eslintConfig: { extends: "x" } }) })).found, ["package.json: eslintConfig"]);
  // A linter inside node_modules is a dependency's, not the project's.
  const deps = projectStaticAnalysis(project({ "package.json": PKG, "node_modules/x/package.json": JSON.stringify({ scripts: { lint: "eslint" } }), "node_modules/x/eslint.config.js": "" }));
  assert.deepEqual(deps, { stacks: ["node"], found: [] });
});

test(".NET: analyzers turned on, an analyzer package or analyzer rules are static analysis; a plain project is not", () => {
  const bare = projectStaticAnalysis(project({ "App.sln": "", "src/App/App.csproj": CSPROJ, ".editorconfig": "root = true\n[*.cs]\nindent_size = 4\n" }));
  assert.deepEqual(bare, { stacks: ["dotnet"], found: [] });
  assert.equal(lacksStaticAnalysis(bare), true);
  const on = CSPROJ.replace("</PropertyGroup>", "<EnableNETAnalyzers>true</EnableNETAnalyzers><AnalysisLevel>latest</AnalysisLevel></PropertyGroup>");
  assert.deepEqual(projectStaticAnalysis(project({ "src/App/App.csproj": on })).found, ["src/App/App.csproj: EnableNETAnalyzers", "src/App/App.csproj: AnalysisLevel"]);
  assert.deepEqual(projectStaticAnalysis(project({ "App.csproj": CSPROJ, "Directory.Build.props": `<Project><ItemGroup><PackageReference Include="StyleCop.Analyzers" Version="1.1.118" /></ItemGroup></Project>` })).found, ["Directory.Build.props: an analyzer package"]);
  assert.deepEqual(projectStaticAnalysis(project({ "App.csproj": CSPROJ, ".editorconfig": "[*.cs]\ndotnet_diagnostic.CA1822.severity = warning\n" })).found, [".editorconfig: analyzer rules"]);
});

test("Unity: a DLL labelled RoslynAnalyzer, a csc.rsp analyzer or analyzer rules; Unity's generated csproj does not make it .NET", () => {
  const unity = { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 2022.3.10f1\n", "Assets/Scripts/Player.cs": "", "Assembly-CSharp.csproj": CSPROJ };
  const bare = projectStaticAnalysis(project({ ...unity, "Library/x.dll.meta": "labels:\n- RoslynAnalyzer\n" }));
  assert.deepEqual(bare, { stacks: ["unity"], found: [] }, "Library is Unity's cache: not looked into");
  assert.equal(lacksStaticAnalysis(bare), true);
  assert.deepEqual(projectStaticAnalysis(project({ ...unity, "Assets/Analyzers/Roslynator.dll.meta": "fileFormatVersion: 2\nlabels:\n- RoslynAnalyzer\n" })).found, ["Assets/Analyzers/Roslynator.dll.meta: RoslynAnalyzer"]);
  assert.deepEqual(projectStaticAnalysis(project({ ...unity, "Assets/csc.rsp": "-a:Analyzers/My.dll\n" })).found, ["Assets/csc.rsp: analyzer"]);
  assert.deepEqual(projectStaticAnalysis(project({ ...unity, ".editorconfig": "[*.cs]\ndotnet_diagnostic.IDE0051.severity = warning\n" })).found, [".editorconfig: analyzer rules"]);
});

test("a stack Nexus does not know is not reminded; the detection works on any listing", () => {
  const other = projectStaticAnalysis(project({ "main.py": "", "README.md": "" }));
  assert.deepEqual(other, { stacks: [], found: [] });
  assert.equal(lacksStaticAnalysis(other), false);
  assert.deepEqual(detectStaticAnalysis(["package.json", "App.csproj"], () => "{}").stacks, ["node", "dotnet"]);
  assert.deepEqual(listProjectFiles(project({ "a/b.txt": "", ".git/config": "", "c.txt": "" })), ["a/b.txt", "c.txt"]);
});

test("the next reminder: at once without a note, a month after the last, not before 90 days after a no", () => {
  assert.equal(staticReminderDue({ protocol: 1 }), 0);
  const t = Date.parse("2026-11-01T10:00:00Z");
  assert.equal(staticReminderDue({ protocol: 1, reminded_at: new Date(t).toISOString() }), t + STATIC_REMIND_EVERY_MS);
  assert.equal(staticReminderDue({ protocol: 1, reminded_at: new Date(t).toISOString(), declined: { at: new Date(t + 1000).toISOString(), reason: "no" } }), t + 1000 + STATIC_DECLINE_REST_MS);
});

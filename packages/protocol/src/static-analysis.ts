// Whether a project has static analysis (docs/protocol/planning.md, "Static analysis reminder"): its stacks (Node, .NET, Unity) and
// what of a linter or analyzer it has set up. A project of a known stack with none of them is reminded, monthly, of
// the shipped "static-analysis" template; one whose stack Nexus does not know is left alone. The detection is pure
// (a list of the project's files and a reader); listing a folder is the last section.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StaticAnalysisNote } from "./schemas.ts";

type Stack = "node" | "dotnet" | "unity";

export interface StaticAnalysis {
  /** The stacks recognised, in this order: node, dotnet, unity (a Unity project is not counted as .NET too). */
  stacks: Stack[];
  /** What was found, each as "<file>: <what>"; empty: no static analysis. */
  found: string[];
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const NODE_CONFIG = /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.(c?js|json|ya?ml))?|biome\.jsonc?|\.oxlintrc\.json|\.jshintrc|tslint\.json)$/;
const DOTNET_PROJECT = /\.(csproj|fsproj|vbproj|sln|slnx)$/;
const MSBUILD = /\.(csproj|fsproj|vbproj)$|^Directory\.(Build|Packages)\.props$/;
/** MSBuild settings that turn analyzers on, or an analyzer package. */
const MSBUILD_ANALYSIS: [RegExp, string][] = [
  [/<EnableNETAnalyzers>\s*true/i, "EnableNETAnalyzers"],
  [/<AnalysisLevel>/i, "AnalysisLevel"],
  [/<AnalysisMode>/i, "AnalysisMode"],
  [/<EnforceCodeStyleInBuild>\s*true/i, "EnforceCodeStyleInBuild"],
  [/<Package(Reference|Version)\s+Include="([^"]*(Analyzers?|SonarAnalyzer[^"]*))"/i, "an analyzer package"],
];
/** An .editorconfig or .globalconfig that sets analyzer rules. */
const RULES = /^\s*(dotnet_diagnostic\.|dotnet_analyzer_diagnostic\.)/m;

/**
 * The project's stacks and its static analysis, from its files (relative paths with `/`, as listProjectFiles gives
 * them) and a reader of one file's text (undefined when it cannot be read). Node: a linter's config (ESLint, Biome,
 * oxlint, JSHint, TSLint), an `eslintConfig` in package.json, or a `lint` script. .NET: analyzers turned on in a
 * project or Directory.Build.props, an analyzer package, or analyzer rules in an .editorconfig or .globalconfig. Unity
 * (ProjectSettings/ProjectVersion.txt): a DLL labelled RoslynAnalyzer, an analyzer in a csc.rsp, or analyzer rules in
 * an .editorconfig.
 */
export function detectStaticAnalysis(files: readonly string[], read: (path: string) => string | undefined): StaticAnalysis {
  const stacks: Stack[] = [];
  const found: string[] = [];
  const unity = files.includes("ProjectSettings/ProjectVersion.txt");
  const packages = files.filter((f) => base(f) === "package.json");
  if (packages.length) stacks.push("node");
  if (!unity && files.some((f) => DOTNET_PROJECT.test(base(f)))) stacks.push("dotnet");
  if (unity) stacks.push("unity");

  if (packages.length) {
    for (const f of files) if (NODE_CONFIG.test(base(f))) found.push(`${f}: linter config`);
    for (const f of packages) {
      let pkg: { eslintConfig?: unknown; scripts?: Record<string, unknown> } | undefined;
      try { pkg = JSON.parse(read(f) ?? "null") ?? undefined; } catch { pkg = undefined; }
      if (pkg?.eslintConfig) found.push(`${f}: eslintConfig`);
      if (typeof pkg?.scripts?.lint === "string") found.push(`${f}: lint script`);
    }
  }
  if (stacks.includes("dotnet") || unity) {
    for (const f of files) {
      const name = base(f);
      if (name === ".editorconfig" || name.endsWith(".globalconfig")) {
        if (RULES.test(read(f) ?? "")) found.push(`${f}: analyzer rules`);
      } else if (!unity && MSBUILD.test(name)) {
        const text = read(f) ?? "";
        for (const [re, what] of MSBUILD_ANALYSIS) if (re.test(text)) found.push(`${f}: ${what}`);
      } else if (unity && /\.dll\.meta$/i.test(name)) {
        if (/^\s*-\s*RoslynAnalyzer\s*$/m.test(read(f) ?? "")) found.push(`${f}: RoslynAnalyzer`);
      } else if (unity && name === "csc.rsp") {
        if (/^\s*[-/](a|analyzer):/m.test(read(f) ?? "")) found.push(`${f}: analyzer`);
      }
    }
  }
  return { stacks, found };
}

/** How often the reminder comes while a project has none, and how long the user's no rests it. */
export const STATIC_REMIND_EVERY_MS = 30 * 24 * 3600_000;
export const STATIC_DECLINE_REST_MS = 90 * 24 * 3600_000;

/**
 * When the next reminder may come (ms since the epoch), by the server's note: a month after the last one, and not
 * before 90 days after the user's last no. Now or earlier: it may come now (if the project still has none).
 */
export function staticReminderDue(note: StaticAnalysisNote): number {
  const last = note.reminded_at ? Date.parse(note.reminded_at) + STATIC_REMIND_EVERY_MS : 0;
  const rest = note.declined ? Date.parse(note.declined.at) + STATIC_DECLINE_REST_MS : 0;
  return Math.max(last, rest);
}

/** A project of a known stack that has no static analysis: the reminder's subject. */
export const lacksStaticAnalysis = (a: StaticAnalysis): boolean => a.stacks.length > 0 && a.found.length === 0;

// ---------------------------------------------------------------- listing a project

/** Folders never looked into: dependencies, build output, version control, Unity's caches, Nexus's own. */
const SKIP = new Set(["node_modules", ".git", ".nexus", "Library", "Temp", "Logs", "obj", "bin", "dist", "build", "out", ".vs", ".idea", "UserSettings"]);
const MAX_DEPTH = 6;
const MAX_FILES = 20_000;

/** The project's files under `root` (relative, with `/`), skipping SKIP's folders, at most 6 deep and 20000 files. */
export function listProjectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      const path = join(dir, name);
      let isDir: boolean;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) { if (!SKIP.has(name) && depth < MAX_DEPTH) walk(path, `${rel}${name}/`, depth + 1); }
      else out.push(`${rel}${name}`);
    }
  };
  walk(root, "", 0);
  return out;
}

/** detectStaticAnalysis on a project's folder. */
export function projectStaticAnalysis(root: string): StaticAnalysis {
  return detectStaticAnalysis(listProjectFiles(root), (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return undefined; } });
}

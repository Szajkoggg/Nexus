// Where the tokens went: a read-only report from Claude Code's and Codex's transcripts, NEXUS_HOME's turns.jsonl and
// the projects' events (decided 2026-11-17, docs/ideas/token-costs.md: measure a baseline, then each change's effect).
//
//   node scripts/token-report.ts [--since <date|time>] [--until <date|time>] [--project <id>]... [--out <file>]
//                                [--top <n>] [--claude-dir <dir>] [--codex-dir <dir>] [--nexus-home <dir>]
//
// It only reads: ~/.claude/projects (every folder, sub-agents' transcripts too), ~/.codex/sessions, <NEXUS_HOME>
// (projects.yaml, turns.jsonl) and each project's .nexus/sessions (session.yaml for the roles, events.jsonl for the
// quality signals). The report holds totals only. The breakdowns are scripts/token-report/analysis.ts; the method is
// docs/DESIGN.md, "Measuring token use"; the use, README.md.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { parse as parseYaml } from "yaml";
import type { TurnRecord } from "@nexus/protocol";
import { sinceTime } from "@nexus/protocol/stats";
import { analyze, inside, render, type EventLine, type Report, type SessionInfo } from "./token-report/analysis.ts";
import { parseClaude, parseCodex, type Transcript } from "./token-report/transcripts.ts";
import { renderWeights, weightEstimates } from "./token-report/weights.ts";

export interface Options {
  since?: string; until?: string; projects?: string[]; top?: number;
  claudeDir: string; codexDir: string; nexusHome: string;
}

const files = (dir: string, test: (name: string) => boolean): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(test).map((f) => join(dir, f));
};

/** Every .jsonl file under a folder, at any depth. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** A file's lines, read a piece at a time: a transcript can be larger than a string may be. */
function* fileLines(file: string): Generator<string> {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  const dec = new StringDecoder("utf8");
  let rest = "";
  try {
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) {
      const parts = (rest + dec.write(buf.subarray(0, n))).split("\n");
      rest = parts.pop() ?? "";
      yield* parts;
    }
    rest += dec.end();
    if (rest) yield rest;
  } finally { closeSync(fd); }
}

/** Claude Code's folder name for a working directory: every character but a letter or a digit becomes "-". */
const claudeFolder = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();

const jsonLines = <T>(file: string): T[] => {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a torn line */ }
  }
  return out;
};

/** Reads every source (read only) and computes the report; `sources` says what was read, for the report's head. */
export function load(o: Options): { report: Report; sources: string[] } {
  const registry = existsSync(join(o.nexusHome, "projects.yaml"))
    ? (parseYaml(readFileSync(join(o.nexusHome, "projects.yaml"), "utf8")) as { projects?: { id: string; root: string }[] })
    : {};
  const projects = (registry.projects ?? []).filter((p) => !o.projects?.length || o.projects.includes(p.id));
  const sessions: SessionInfo[] = [];
  const events: EventLine[] = [];
  for (const p of projects) {
    const dir = join(p.root, ".nexus", "sessions");
    for (const s of files(dir, () => true)) {
      const yaml = join(s, "session.yaml");
      if (!existsSync(yaml)) continue;
      const f = parseYaml(readFileSync(yaml, "utf8")) as SessionInfo;
      sessions.push({ id: f.id, project: f.project, role: f.role, runtime: f.runtime, native_id: f.native_id });
      events.push(...jsonLines<EventLine>(join(s, "events.jsonl")));
    }
  }
  // Only the projects' transcripts are parsed: a known session's, or one in a project's folder (other projects' can be
  // large). A Codex transcript names its session and folder in its first line.
  const roots = projects.map((p) => p.root);
  const natives = new Set(sessions.map((s) => s.native_id).filter((n): n is string => !!n));
  const folders = roots.map(claudeFolder);
  const ours = (dir: string) => {
    const d = basename(dir).toLowerCase();
    return folders.some((f) => d === f || d.startsWith(`${f}-worktrees-`));
  };
  const transcripts: Transcript[] = [];
  let claudeFiles = 0;
  for (const dir of files(o.claudeDir, () => true).filter((d) => statSync(d).isDirectory())) {
    for (const f of files(dir, (n) => n.endsWith(".jsonl"))) {
      const session = basename(f, ".jsonl");
      if (!natives.has(session) && !ours(dir)) continue;
      claudeFiles++;
      transcripts.push(parseClaude(fileLines(f), { session, subagent: false }));
      for (const sub of files(join(dir, session, "subagents"), (n) => n.endsWith(".jsonl"))) {
        claudeFiles++;
        transcripts.push(parseClaude(fileLines(sub), { session, subagent: true }));
      }
    }
  }
  let codexFiles = 0;
  for (const f of walk(o.codexDir)) {
    const lines = fileLines(f);
    const first = lines.next();
    if (first.done) continue;
    let meta: { id?: string; parent_thread_id?: string; cwd?: string } = {};
    try { meta = (JSON.parse(first.value) as { payload?: typeof meta }).payload ?? {}; } catch { /* not a transcript */ }
    const id = meta.parent_thread_id ?? meta.id;
    if (!(id && natives.has(id)) && !inside(meta.cwd, roots)) { lines.return(undefined); continue; }
    codexFiles++;
    transcripts.push(parseCodex((function* () { yield first.value; yield* lines; })()));
  }
  const turnsFile = join(o.nexusHome, "turns.jsonl");
  const turns = jsonLines<TurnRecord>(turnsFile);
  const report = analyze({
    transcripts, turns, events, sessions, roots,
    projects: projects.map((p) => p.id), since: o.since, until: o.until, top: o.top,
  });
  const sources = [
    `${o.claudeDir} (${claudeFiles} transcript files of these projects, sub-agents' included)`,
    `${o.codexDir} (${codexFiles} transcript files of these projects)`,
    `${turnsFile} (${turns.length} turn records, every project's)`,
    ...projects.map((p) => `${join(p.root, ".nexus", "sessions")} (session roles and events)`),
  ];
  return { report, sources };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      since: { type: "string" }, until: { type: "string" }, project: { type: "string", multiple: true },
      out: { type: "string" }, top: { type: "string" }, weights: { type: "boolean" }, "stretch-minutes": { type: "string" },
      "claude-dir": { type: "string" }, "codex-dir": { type: "string" }, "nexus-home": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("usage: node scripts/token-report.ts [--since <date|time>] [--until <date|time>] [--project <id>]... [--out <file>] [--top <n>] [--claude-dir <dir>] [--codex-dir <dir>] [--nexus-home <dir>]\n       node scripts/token-report.ts --weights [--since …] [--until …] [--stretch-minutes <n>] [--out <file>] [--nexus-home <dir>]");
    return;
  }
  const time = (name: string, v: string | undefined) => {
    if (v === undefined) return undefined;
    const t = sinceTime(v);
    if (!t) { console.error(`--${name}: not a date or a time: ${v}`); process.exit(2); }
    return t;
  };
  const top = values.top === undefined ? undefined : Number(values.top);
  if (top !== undefined && !(Number.isInteger(top) && top > 0)) { console.error(`--top: not a positive whole number: ${values.top}`); process.exit(2); }
  const since = time("since", values.since);
  const until = time("until", values.until);
  const nexusHome = values["nexus-home"] ?? process.env.NEXUS_HOME ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "Nexus");
  let text: string;
  if (values.weights) {
    // The usage windows' weights (weights.ts): turns.jsonl alone, every project's turns.
    const minMinutes = values["stretch-minutes"] === undefined ? 60 : Number(values["stretch-minutes"]);
    if (!(minMinutes > 0)) { console.error(`--stretch-minutes: not a positive number: ${values["stretch-minutes"]}`); process.exit(2); }
    const turns = jsonLines<TurnRecord>(join(nexusHome, "turns.jsonl"));
    const inPeriod = turns.filter((t) => (!since || t.at >= since) && (!until || t.at < until)).length;
    text = renderWeights(weightEstimates(turns, { since, until, minMinutes }), { since, until, minMinutes, turns: inPeriod });
  } else {
    const { report, sources } = load({
      since, until, projects: values.project, top, nexusHome,
      claudeDir: values["claude-dir"] ?? join(homedir(), ".claude", "projects"),
      codexDir: values["codex-dir"] ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
    });
    text = render(report, sources);
  }
  if (values.out) writeFileSync(values.out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

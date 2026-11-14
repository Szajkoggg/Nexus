// Where a project's rules live (DESIGN.md, "A project's rules: AGENTS.md, pulled into CLAUDE.md"). Codex reads
// AGENTS.md; Claude Code reads CLAUDE.md and sees AGENTS.md only when CLAUDE.md pulls it in with a line `@AGENTS.md`.
// Nexus's convention: the rules are in AGENTS.md, and CLAUDE.md pulls them in. This module is the pure check of a
// project root's two files (their contents in, the result out) and the fix it offers, which keeps the files' line
// endings and BOM. Reading and writing the files is the server's (actions.ts, `fixProjectRules`).

/**
 * - `linked`: both files, CLAUDE.md pulls in AGENTS.md: both runtimes see the rules.
 * - `neither`: no rules file (or a CLAUDE.md that holds nothing but the link): nothing to warn about.
 * - `only-agents`: Claude Code would not see the rules.
 * - `only-claude`: Codex would not see the rules.
 * - `unlinked`: both files, CLAUDE.md does not pull in AGENTS.md: Claude Code would not see AGENTS.md's rules.
 */
export type RulesState = "linked" | "neither" | "only-agents" | "only-claude" | "unlinked";

/** A file the fix creates or replaces, with its whole content before and after (before: absent for a new file). */
export interface RulesFileChange {
  file: "AGENTS.md" | "CLAUDE.md";
  action: "create" | "replace";
  before?: string;
  after: string;
}

export interface RulesFix {
  changes: RulesFileChange[];
  /** Moving CLAUDE.md into AGENTS.md: the @imports in the moved text, which Codex does not follow. */
  imports: string[];
}

export interface RulesCheck {
  state: RulesState;
  agents: boolean;
  claude: boolean;
  /** The runtime that would not see the project's rules. */
  unseen_by?: "claude" | "codex";
  fix?: RulesFix;
}

const BOM = "\uFEFF";
const LINK = /^\s*@(\.\/)?AGENTS\.md\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** The text's lines, each with its own line ending (the last may have none). */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Each line with whether it lies inside a code fence (the fence lines themselves count as inside). */
function fenced(text: string): { line: string; code: boolean }[] {
  let open: string | undefined;
  return lines(text).map((line) => {
    const m = FENCE.exec(line.replace(/^\uFEFF/, ""));
    if (open) {
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && !line.trim().slice(m[1]!.length).trim()) open = undefined;
      return { line, code: true };
    }
    if (m) { open = m[1]; return { line, code: true }; }
    return { line, code: false };
  });
}

const bare = (line: string) => line.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");

/** CLAUDE.md pulls in AGENTS.md: a line `@AGENTS.md` or `@./AGENTS.md` anywhere outside code fences. */
export function isLinked(claude: string): boolean {
  return fenced(claude).some((l) => !l.code && LINK.test(bare(l.line)));
}

/** The file's line ending: CRLF when it has one, else LF. */
export const lineEnding = (text: string): "\r\n" | "\n" => (text.includes("\r\n") ? "\r\n" : "\n");

/** The text without its link lines (moved into AGENTS.md, they would import the file itself). */
function withoutLinks(text: string): string {
  return fenced(text).filter((l) => l.code || !LINK.test(bare(l.line))).map((l) => l.line).join("");
}

/** The @imports Claude Code follows in a text (`@path`, outside code fences and code spans). */
export function claudeImports(text: string): string[] {
  const found = new Set<string>();
  for (const l of fenced(text)) {
    if (l.code) continue;
    const prose = bare(l.line).replace(/`[^`]*`/g, " ");
    for (const m of prose.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const path = m[1]!.replace(/[).,;:!?]+$/, "");
      if (/[./~\\]/.test(path)) found.add(`@${path}`);
    }
  }
  return [...found];
}

/** The check of a project root, from its files' contents (undefined: the file does not exist). Pure. */
export function checkRules(files: { agents?: string; claude?: string }): RulesCheck {
  const { agents, claude } = files;
  const has = { agents: agents !== undefined, claude: claude !== undefined };
  if (agents !== undefined && claude !== undefined) {
    if (isLinked(claude)) return { state: "linked", ...has };
    const bom = claude.startsWith(BOM) ? BOM : "";
    const after = `${bom}@AGENTS.md${lineEnding(claude)}${claude.slice(bom.length)}`;
    return { state: "unlinked", ...has, unseen_by: "claude", fix: { changes: [{ file: "CLAUDE.md", action: "replace", before: claude, after }], imports: [] } };
  }
  if (agents !== undefined) {
    return { state: "only-agents", ...has, unseen_by: "claude",
      fix: { changes: [{ file: "CLAUDE.md", action: "create", after: `@AGENTS.md${lineEnding(agents)}` }], imports: [] } };
  }
  if (claude !== undefined) {
    const bom = claude.startsWith(BOM) ? BOM : "";
    const moved = bom + withoutLinks(claude).replace(/^\uFEFF/, "");
    if (!moved.slice(bom.length).trim()) return { state: "neither", ...has };
    return { state: "only-claude", ...has, unseen_by: "codex", fix: {
      changes: [
        { file: "AGENTS.md", action: "create", after: moved },
        { file: "CLAUDE.md", action: "replace", before: claude, after: `${bom}@AGENTS.md${lineEnding(claude)}` },
      ],
      imports: claudeImports(moved),
    } };
  }
  return { state: "neither", ...has };
}

const RUNTIME = { claude: "Claude Code", codex: "Codex" } as const;

/** The check in one or two lines of English, for `nexus project add`. */
export function describeRules(c: RulesCheck): string {
  switch (c.state) {
    case "linked": return "rules: AGENTS.md, pulled into CLAUDE.md: both Claude Code and Codex see them";
    case "neither": return "rules: no AGENTS.md or CLAUDE.md in the project (nothing to check)";
    case "only-agents": return `warning: ${RUNTIME.claude} would not see the project's rules: there is an AGENTS.md but no CLAUDE.md.\n    Fix: on the project's page in the dashboard (it creates CLAUDE.md with the line @AGENTS.md).`;
    case "only-claude": return `warning: ${RUNTIME.codex} would not see the project's rules: there is a CLAUDE.md but no AGENTS.md.\n    Fix: on the project's page in the dashboard (it moves CLAUDE.md's content into a new AGENTS.md and leaves CLAUDE.md as @AGENTS.md).`;
    case "unlinked": return `warning: ${RUNTIME.claude} would not see the rules in AGENTS.md: CLAUDE.md does not pull it in.\n    Fix: on the project's page in the dashboard (it adds @AGENTS.md as the first line of CLAUDE.md).`;
  }
}

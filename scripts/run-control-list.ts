// The run-control list kept in two places: AGENTS.md's "Run control and lifecycle code" item and the default of the
// nexus-lifecycle template's lifecycle_code parameter (nexus-templates/nexus-lifecycle.yaml). Pure functions over the
// two texts, so scripts/test/run-control-list.test.ts can show them on a faulty example and run them on the real files.
import { parse } from "yaml";

const AGENTS_ITEM = "- **Run control and lifecycle code**";

/** The `*.ts` files AGENTS.md's run-control item names in backticks (the item runs to the next list item). */
export function agentsRunControl(agents: string): string[] {
  const lines = agents.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(AGENTS_ITEM));
  if (start < 0) throw new Error(`AGENTS.md has no item "${AGENTS_ITEM}"`);
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  const item = lines.slice(start, end < 0 ? undefined : end).join("\n");
  return [...item.matchAll(/`([\w-]+\.ts)`/g)].map((m) => m[1] ?? "");
}

/** The `*.ts` files the template's lifecycle_code default names. */
export function templateRunControl(template: string): string[] {
  const doc = parse(template) as { params?: { name: string; default?: string }[] };
  const param = doc.params?.find((p) => p.name === "lifecycle_code");
  if (!param?.default) throw new Error("the template has no default for lifecycle_code");
  return [...param.default.matchAll(/\b([\w-]+\.ts)\b/g)].map((m) => m[1] ?? "");
}

/** Where the two lists differ: a file only one of them names. Empty when they name the same files. */
export function runControlDifferences(agents: readonly string[], template: readonly string[]): string[] {
  const a = new Set(agents);
  const t = new Set(template);
  return [
    ...[...a].filter((f) => !t.has(f)).map((f) => `${f}: in AGENTS.md, not in the nexus-lifecycle default`),
    ...[...t].filter((f) => !a.has(f)).map((f) => `${f}: in the nexus-lifecycle default, not in AGENTS.md`),
  ];
}

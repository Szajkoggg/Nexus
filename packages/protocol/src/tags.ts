// Step tags (docs/ideas/tags.md; PROTOCOL.md, "Tags"): facets that each answer one question about a step. `kind`:
// how hard the thinking is, exactly one per step, the dominant one (it will drive the runtime, model, effort and
// fallback); `activities`: what the step does; `area`: which part of the project; `size`: S, M or L as planned;
// `origin`: where the work came from. Nexus's own lists are here; each project keeps its areas and the activities it
// adds (with the project's prefix) in .nexus/tags.yaml, which only the server writes: the orchestrator proposes, the
// user accepts. No free text: a draft uses names from these lists only. A renamed name is read as the new one
// everywhere; files that carry the old one are never rewritten, so the history does not split.
// Pure and free of Node: the dashboard imports this module directly (`@nexus/protocol/tags`); the proposals and the
// user's decisions, which write tags.yaml, are in tag-proposals.ts.
import type { StepDef, TagProposal, TagsFile } from "./schemas.ts";

/** Nexus's kinds of work, from the most mechanical: each will have its own runtime, model, effort and fallback. */
export const TAG_KINDS = ["mechanical", "code", "debugging", "design", "research", "docs"] as const;

/** Nexus's suggested activities, shared by every project (the statistics compare these across projects). */
export const NEXUS_ACTIVITIES = [
  "feature", "bugfix", "refactor", "test", "performance", "security", "migration", "dependency", "ui", "i18n",
  "capture", "integration", "cleanup", "build",
  // for games
  "assets", "tuning", "content",
] as const;

/**
 * Where the work came from: the user; maintenance (a recurring or housekeeping queue, Nexus's closing steps); the
 * orchestrator's own initiative; a fix (after a send-back or the user's Fix it); CI or a bug found by a failure.
 */
export const TAG_ORIGINS = ["user", "maintenance", "orchestrator", "fix", "ci"] as const;

export const TAG_SIZES = ["S", "M", "L"] as const;

/** An area's name, and the part of a project activity after its prefix: lowercase words joined by hyphens. */
export const TAG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A project activity: the project's prefix (a lowercase letter, then up to 7 letters or digits), a colon, a name. */
export const PROJECT_ACTIVITY = /^([a-z][a-z0-9]{0,7}):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** The tag fields of a step, or of a queue (its steps' defaults). */
export type StepTags = Partial<Pick<StepDef, "kind" | "activities" | "area" | "size" | "origin">>;
const TAG_KEYS = ["kind", "activities", "area", "size", "origin"] as const;

/** A step's tags with its queue's where it sets none (a step's `activities` replace the queue's, they do not add up). */
export function inheritedTags(step: StepTags, queue: StepTags): StepTags {
  const out: Record<string, unknown> = {};
  for (const k of TAG_KEYS) {
    const v = step[k] ?? queue[k];
    if (v !== undefined) out[k] = v;
  }
  return out as StepTags;
}

/** A name read through the project's renames (followed to the newest name; a loop ends where it began). */
export function renamedTag(name: string, renames: TagsFile["renames"]): string {
  const seen = new Set<string>();
  let n = name;
  for (;;) {
    const r = renames.findLast((x) => x.from === n);
    if (!r || seen.has(n)) return n;
    seen.add(n);
    n = r.to;
  }
}

/** Tags as they read now: areas and project activities through the renames (Nexus's own names are never renamed). */
function readTags(tags: StepTags, list: Pick<TagsFile, "renames">): StepTags {
  if (!list.renames.length) return tags;
  const out: StepTags = { ...tags };
  if (tags.area !== undefined) out.area = renamedTag(tags.area, list.renames);
  if (tags.activities) out.activities = [...new Set(tags.activities.map((a) => renamedTag(a, list.renames)))];
  return out;
}

/** A step's tags as they read now: its own over its queue's, renames read through. */
export function stepTags(step: StepTags, queue: StepTags, list: Pick<TagsFile, "renames">): StepTags {
  return readTags(inheritedTags(step, queue), list);
}

/**
 * Planned against observed activities (the step's tags against what its worker reported at `nexus step done`): `both`
 * planned and done, `unplanned` done but not planned, `skipped` planned but not reported. Undefined while the worker
 * reported none (nothing to compare). The difference is itself a measure (docs/ideas/tags.md).
 */
export function activityDifference(planned: readonly string[] | undefined, observed: readonly string[] | undefined): { both: string[]; unplanned: string[]; skipped: string[] } | undefined {
  if (!observed) return undefined;
  const p = planned ?? [];
  return { both: observed.filter((a) => p.includes(a)), unplanned: observed.filter((a) => !p.includes(a)), skipped: p.filter((a) => !observed.includes(a)) };
}

/** The tags in one line, for the CLI and a briefing: "code; feature, test; area engine; size M; from user". */
export function tagsText(t: StepTags): string {
  return [
    t.kind, t.activities?.length ? t.activities.join(", ") : undefined, t.area ? `area ${t.area}` : undefined,
    t.size ? `size ${t.size}` : undefined, t.origin ? `from ${t.origin}` : undefined,
  ].filter(Boolean).join("; ");
}

const includes = (list: readonly string[], x: string) => list.includes(x);
const pending = (list: TagsFile, kind: TagProposal["kind"], name: string) => list.proposals.some((p) => p.kind === kind && p.name === name);
/** The rename that took a name away, if any. */
export const renamedFrom = (list: Pick<TagsFile, "renames">, name: string) => list.renames.findLast((r) => r.from === name);

/**
 * What is wrong with tags against Nexus's lists and the project's (empty: nothing). Every name must be on a list as it
 * is now: one proposed but not accepted yet, or renamed since, is refused with what to do instead.
 */
export function tagIssues(t: StepTags, list: TagsFile): string[] {
  const out: string[] = [];
  if (t.kind !== undefined) {
    if (/[,\s]/.test(t.kind.trim())) out.push(`a step has exactly one kind, the dominant one (not ${t.kind}); what else it does goes into its activities`);
    else if (!includes(TAG_KINDS, t.kind)) out.push(`kind ${t.kind} is not one of Nexus's kinds (${TAG_KINDS.join(", ")})`);
  }
  if (t.origin !== undefined && !includes(TAG_ORIGINS, t.origin)) out.push(`origin ${t.origin} is not one of Nexus's origins (${TAG_ORIGINS.join(", ")})`);
  const seen = new Set<string>();
  for (const a of t.activities ?? []) {
    if (seen.has(a)) { out.push(`activity ${a} is listed twice`); continue; }
    seen.add(a);
    if (includes(NEXUS_ACTIVITIES, a) || list.activities.some((x) => x.name === a)) continue;
    const r = renamedFrom(list, a);
    if (r) out.push(`activity ${a} was renamed to ${renamedTag(a, list.renames)}: use the new name`);
    else if (pending(list, "activity", a)) out.push(`activity ${a} is proposed and waits for the user's acceptance: it can be used once the user accepts it`);
    else if (a.includes(":")) out.push(`activity ${a} is not in the project's list: propose it with nexus tags propose --activity ${a} --reason "..."; the user accepts it`);
    else out.push(`activity ${a} is not one of Nexus's activities (${NEXUS_ACTIVITIES.join(", ")}); a project's own activity carries the project's prefix (${list.prefix ?? "prefix"}:${a}) and is proposed with nexus tags propose`);
  }
  if (t.area !== undefined && !list.areas.some((x) => x.name === t.area)) {
    const r = renamedFrom(list, t.area);
    if (r) out.push(`area ${t.area} was renamed to ${renamedTag(t.area, list.renames)}: use the new name`);
    else if (pending(list, "area", t.area)) out.push(`area ${t.area} is proposed and waits for the user's acceptance: it can be used once the user accepts it`);
    else out.push(`area ${t.area} is not in the project's list${list.areas.length ? ` (${list.areas.map((x) => x.name).join(", ")})` : " (it has none yet)"}: propose it with nexus tags propose --area ${t.area} --reason "..."; the user accepts it`);
  }
  return out;
}

/** "a step has exactly one kind" for a draft whose kind is a list (the schema would only say "expected string"). */
export function kindListIssue(x: unknown): string | undefined {
  const k = x && typeof x === "object" ? (x as { kind?: unknown }).kind : undefined;
  return Array.isArray(k) ? `a step has exactly one kind, the dominant one (not ${k.join(", ")}); what else it does goes into its activities` : undefined;
}

// ---------------------------------------------------------------- the project's lists: proposals and the user's decisions

/** What a proposal asks, as the user reads it: "New area engine", "Rename area engine to core". */
export function tagProposalText(p: Pick<TagProposal, "kind" | "name" | "from">, list?: Pick<TagsFile, "areas">): string {
  if (p.kind === "area") return `New area ${p.name}`;
  if (p.kind === "activity") return `New activity ${p.name}`;
  const what = list?.areas.some((a) => a.name === p.from) || !p.from?.includes(":") ? "area" : "activity";
  return `Rename ${what} ${p.from} to ${p.name}`;
}

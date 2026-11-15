// Step tags (docs/ideas/tags.md; PROTOCOL.md, "Tags"): facets that each answer one question about a step. `kind`:
// how hard the thinking is, exactly one per step, the dominant one (it will drive the runtime, model, effort and
// fallback); `activities`: what the step does; `area`: which part of the project; `size`: S, M or L as planned;
// `origin`: where the work came from. Nexus's own lists are here; each project keeps its areas and the activities it
// adds (with the project's prefix) in .nexus/tags.yaml, which only the server writes: the orchestrator proposes, the
// user accepts. No free text: a draft uses names from these lists only. A renamed name is read as the new one
// everywhere; files that carry the old one are never rewritten, so the history does not split.
import { ActionError } from "./actions.ts";
import type { StepDef, TagProposal, TagsFile } from "./schemas.ts";
import { newId, now, type ProjectStore } from "./store.ts";

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
const TAG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A project activity: the project's prefix (a lowercase letter, then up to 7 letters or digits), a colon, a name. */
const PROJECT_ACTIVITY = /^([a-z][a-z0-9]{0,7}):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

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

/** The tags in one line, for the CLI and a briefing: "code; feature, test; area engine; size M; from user". */
export function tagsText(t: StepTags): string {
  return [
    t.kind, t.activities?.length ? t.activities.join(", ") : undefined, t.area ? `area ${t.area}` : undefined,
    t.size ? `size ${t.size}` : undefined, t.origin ? `from ${t.origin}` : undefined,
  ].filter(Boolean).join("; ");
}

const includes = (list: readonly string[], x: string) => list.includes(x);
const pending = (list: TagsFile, kind: TagProposal["kind"], name: string) => list.proposals.some((p) => p.kind === kind && p.name === name);
const renamedFrom = (list: TagsFile, name: string) => list.renames.findLast((r) => r.from === name);

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

/** The prefix the project's activities carry: the list's, else that of an activity proposed and not decided yet. */
function prefixOf(list: TagsFile): string | undefined {
  if (list.prefix) return list.prefix;
  const p = list.proposals.find((x) => x.kind === "activity");
  return p ? PROJECT_ACTIVITY.exec(p.name)?.[1] : undefined;
}

/** A new name is free: on no list, not proposed, not a name renamed away (which still reads as its new one). */
function checkFree(list: TagsFile, kind: "area" | "activity", name: string): void {
  const on = (kind === "area" ? list.areas : list.activities).some((x) => x.name === name);
  if (on) throw new ActionError(`${kind} ${name} is in the project's list already`, 409);
  const r = renamedFrom(list, name);
  if (r) throw new ActionError(`${name} was renamed to ${renamedTag(name, list.renames)}: an old name stays read as the new one, so it is not used again`, 409);
  if (list.proposals.some((p) => p.name === name)) throw new ActionError(`${name} is proposed already and waits for the user`, 409);
}

function checkActivity(list: TagsFile, name: string): void {
  if (includes(NEXUS_ACTIVITIES, name)) throw new ActionError(`${name} is one of Nexus's activities: use it as it is`);
  const m = PROJECT_ACTIVITY.exec(name);
  if (!m) throw new ActionError(`a project's own activity is its prefix, a colon and a name in lowercase words joined by hyphens (hc:terrain), not ${name}`);
  const prefix = prefixOf(list);
  if (prefix && m[1] !== prefix) throw new ActionError(`the project's own activities carry its prefix ${prefix} (${prefix}:${m[2]}), not ${m[1]}`);
}

function checkArea(name: string): void {
  if (!TAG_NAME.test(name)) throw new ActionError(`an area is lowercase words joined by hyphens (terrain, game-logic), not ${name}`);
}

/**
 * The orchestrator's proposal to change the project's lists (its `tags.proposed` event, from `nexus tags propose` or
 * `nexus tags rename`): exactly one of a new area, a new project activity, or a rename of one of them. It goes into
 * tags.yaml's proposals, which wait in the user's list; nothing is on a list until the user accepts it. Returns what
 * happened, in a sentence.
 */
export function proposeTags(store: ProjectStore, req: { area?: string; activity?: string; rename?: { from: string; to: string }; reason?: string }, session?: string): string {
  const given = [req.area, req.activity, req.rename].filter((x) => x !== undefined).length;
  if (given !== 1) throw new ActionError("a proposal is one of: a new area, a new activity, or a rename");
  const list = store.readTags();
  const reason = req.reason?.trim() || undefined;
  let p: TagProposal;
  if (req.area !== undefined) {
    const name = req.area.trim();
    checkArea(name);
    checkFree(list, "area", name);
    p = { id: newId(), at: now(), kind: "area", name, reason, session };
  } else if (req.activity !== undefined) {
    const name = req.activity.trim();
    checkActivity(list, name);
    checkFree(list, "activity", name);
    p = { id: newId(), at: now(), kind: "activity", name, reason, session };
  } else {
    const from = req.rename!.from.trim(), to = req.rename!.to.trim();
    const kind = list.areas.some((x) => x.name === from) ? "area" : list.activities.some((x) => x.name === from) ? "activity" : undefined;
    if (!kind) {
      throw new ActionError(includes(TAG_KINDS, from) || includes(NEXUS_ACTIVITIES, from) || includes(TAG_ORIGINS, from)
        ? `${from} is one of Nexus's own names: only the project's areas and activities are renamed`
        : `${from} is neither an area nor an activity in the project's list`, 404);
    }
    if (kind === "area") checkArea(to); else checkActivity(list, to);
    checkFree(list, kind, to);
    if (list.proposals.some((x) => x.kind === "rename" && x.from === from)) throw new ActionError(`a rename of ${from} is proposed already and waits for the user`, 409);
    p = { id: newId(), at: now(), kind: "rename", name: to, from, reason, session };
  }
  store.writeTags({ ...list, proposals: [...list.proposals, p] });
  return `your proposal (${tagProposalText(p, list).toLowerCase()}) waits for the user's acceptance; until then a draft that uses it is refused`;
}

/** A proposal waiting for the user, or a refusal. */
function proposalOf(list: TagsFile, id: string): TagProposal {
  const p = list.proposals.find((x) => x.id === id);
  if (!p) throw new ActionError(`no tag proposal ${id} waits for a decision`, 404);
  return p;
}

/**
 * The user accepts a proposal: a new area or activity goes onto the project's list (the first activity fixes the
 * project's prefix); a rename renames the entry and records the rename, so the old name reads as the new one from now
 * on. Only the user: the server takes it only from the dashboard's page; there is no CLI command and no event for it.
 */
export function acceptTagProposal(store: ProjectStore, id: string): string {
  const list = store.readTags();
  const p = proposalOf(list, id);
  const at = now();
  const rest = list.proposals.filter((x) => x.id !== id);
  const decided = [...list.decisions, { at, accepted: true, proposal: p }];
  const entry = { name: p.name, at, ...(p.reason ? { reason: p.reason } : {}) };
  if (p.kind === "area") {
    const has = list.areas.some((x) => x.name === p.name);
    store.writeTags({ ...list, areas: has ? list.areas : [...list.areas, entry], proposals: rest, decisions: decided });
    return `area ${p.name} is on the project's list`;
  }
  if (p.kind === "activity") {
    const has = list.activities.some((x) => x.name === p.name);
    const prefix = list.prefix ?? PROJECT_ACTIVITY.exec(p.name)?.[1];
    store.writeTags({ ...list, prefix, activities: has ? list.activities : [...list.activities, entry], proposals: rest, decisions: decided });
    return `activity ${p.name} is on the project's list`;
  }
  const from = p.from!;
  const rename = (xs: TagsFile["areas"]) => xs.map((x) => (x.name === from ? { ...x, name: p.name } : x));
  if (!list.areas.some((x) => x.name === from) && !list.activities.some((x) => x.name === from)) {
    throw new ActionError(`${from} is no longer on the project's list: decline the proposal`, 409);
  }
  store.writeTags({
    ...list, areas: rename(list.areas), activities: rename(list.activities),
    renames: [...list.renames, { from, to: p.name, at }], proposals: rest, decisions: decided,
  });
  return `${from} is renamed to ${p.name}; everything tagged ${from} reads as ${p.name}`;
}

/** The user declines a proposal: the lists stay as they were. Only the user, like acceptTagProposal. */
export function declineTagProposal(store: ProjectStore, id: string): string {
  const list = store.readTags();
  const p = proposalOf(list, id);
  store.writeTags({ ...list, proposals: list.proposals.filter((x) => x.id !== id), decisions: [...list.decisions, { at: now(), accepted: false, proposal: p }] });
  return `the proposal (${tagProposalText(p, list).toLowerCase()}) is declined`;
}

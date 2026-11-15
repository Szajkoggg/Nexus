// The project's tag lists (.nexus/tags.yaml): the orchestrator's proposals and the user's decisions on them (tags.ts;
// PROTOCOL.md, "Tags"). The server is the only writer of the file.
import { ActionError } from "./actions.ts";
import type { TagProposal, TagsFile } from "./schemas.ts";
import { newId, now, type ProjectStore } from "./store.ts";
import { NEXUS_ACTIVITIES, PROJECT_ACTIVITY, TAG_KINDS, TAG_NAME, TAG_ORIGINS, renamedFrom, renamedTag, tagProposalText } from "./tags.ts";

const includes = (list: readonly string[], x: string) => list.includes(x);

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

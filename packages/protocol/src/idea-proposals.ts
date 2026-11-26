// The agents' idea-link proposals (queue IWS, docs/ux/idea-work-signals.md part d; docs/protocol/conversations.md,
// agents' link proposals): an agent's `ideas.links_proposed` event is taken into .nexus/idea-proposals.yaml by the server,
// which is that file's one writer; nothing changes until the user accepts. Only the user's acceptance writes a link,
// through the relationships' writer (idea-link-actions.ts), each accepted item one action with `proposal: {id, by}`.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActionError } from "./actions.ts";
import { linkEditor, recordAction, withIdeaLinks } from "./idea-link-actions.ts";
import { deriveIdeaLinks, ideaHash, type IdeaLinksResponse, type IdeaLinkView } from "./idea-links.ts";
import { readNotes } from "./ideas-read.ts";
import { noteRefIssue, type IdeaNote } from "./ideas.ts";
import type { Event, IdeaLinkAction, IdeaLinkProposalItem, IdeaProposal, IdeaProposalsFile, IdeaProposer, SessionFile } from "./schemas.ts";
import type { ProjectState } from "./state.ts";
import { compareIds } from "./ids.ts";
import { now, type ProjectStore } from "./store.ts";

/** What a session that may not propose is told (the CLI's refusal and the server's intake say the same). */
export const PROPOSER_REFUSAL = "only the orchestrator, a thinking partner or a worker of a maintenance queue may propose idea links";

/**
 * Who proposed, or undefined when the session may not: the orchestrator, a thinking partner, or a worker of a
 * maintenance queue (its queue's `maintenance`, survey or fix_small; not the `origin: maintenance` tag, which closing
 * steps of ordinary queues carry too).
 */
export function proposerOf(store: ProjectStore, s: SessionFile, step?: string): IdeaProposer | undefined {
  const by = { session: s.id, ...(s.title ? { title: s.title } : {}) };
  if (s.role === "orchestrator" || s.role === "conversation") return { ...by, role: s.role };
  if (s.role !== "worker" || !s.queue) return undefined;
  let maintenance: string | undefined;
  try { maintenance = store.readQueue(s.queue).maintenance; } catch { return undefined; }
  return maintenance ? { ...by, role: "worker", queue: s.queue, ...(step ? { step } : {}) } : undefined;
}

/** An item checked against the relationships as they stand: whether it applies, why not, and what it would do. */
interface ProposalCheck {
  /** Applies now. */
  ok: boolean;
  /** Why it does not: an unknown queue or reference (`refused` at intake) or a link state that no longer fits. */
  why?: string;
  refused?: boolean;
  /** What accepting it does to the edge's origins, a line each (shown to the user). */
  mapping: string[];
  /** The edge's effective origins (remove, replace). */
  origins: IdeaLinkView[];
}

const ORIGIN_LABEL = { source: "the queue's source", match: "a historical match", manual: "a manual link" } as const;

/** Checks an item against the origins (`view`) as they stand (decision D8: again at acceptance). */
function checkProposal(view: IdeaLinksResponse, state: ProjectState, notes: readonly IdeaNote[], item: Pick<IdeaLinkProposalItem, "op" | "queue" | "ref" | "to">): ProposalCheck {
  const no = (why: string, refused = false): ProposalCheck => ({ ok: false, why, ...(refused ? { refused } : {}), mapping: [], origins: [] });
  if (!state.queues.some((q) => q.id === item.queue)) return no(`queue ${item.queue} does not exist`, true);
  const dir = state.project.conversations.notes_dir;
  const issue = noteRefIssue(item.ref, dir, notes) ?? (item.to !== undefined ? noteRefIssue(item.to, dir, notes) : undefined);
  if (issue) return no(issue, true);
  if (item.op === "replace" && (!item.to || item.to === item.ref)) return no("a replacement names another entry with --to", true);
  const on = (ref: string) => view.items.filter((r) => r.queue === item.queue && r.ref === ref && r.effective);
  const origins = on(item.ref);
  if (item.op === "add") {
    if (origins.length) return no(`this link already exists (${origins.map((r) => ORIGIN_LABEL[r.origin]).join(", ")})`);
    return { ok: true, mapping: ["Adds a manual link."], origins };
  }
  if (!origins.length) return no("this link no longer exists");
  const removal = (r: IdeaLinkView) => r.origin === "source"
    ? "This is the queue's own source: ignores it (the queue file does not change)."
    : r.origin === "match" ? "Removes the historical match." : "Removes the manual link.";
  if (item.op === "remove") return { ok: true, mapping: origins.map(removal), origins };
  if (on(item.to!).length) return no(`${item.queue} is linked to ${item.to} already`);
  const [first, ...rest] = origins;
  const change = first!.origin === "source"
    ? `Corrects the queue's source: ignores it and links ${item.to} instead (the queue file does not change).`
    : "Changes the target.";
  return { ok: true, mapping: [change, ...rest.map(removal)], origins };
}

/** The relationships as they stand now, for checking proposals outside a write. */
function currentLinks(store: ProjectStore, state: ProjectState): { view: IdeaLinksResponse; notes: IdeaNote[] } {
  const notes = readNotes(state.project.root, state.project.conversations.notes_dir);
  return { view: deriveIdeaLinks(store.readIdeaMatches(), state, notes), notes };
}

const same = (a: Pick<IdeaProposal, "op" | "queue" | "ref" | "to">, b: Pick<IdeaProposal, "op" | "queue" | "ref" | "to">) =>
  a.op === b.op && a.queue === b.queue && a.ref === b.ref && a.to === b.to;

/** A pending proposal the same as the item, if one waits already. */
function pendingSame(file: IdeaProposalsFile, item: Pick<IdeaProposal, "op" | "queue" | "ref" | "to">): IdeaProposal | undefined {
  return file.proposals.find((p) => p.state === "pending" && same(p, item));
}

/**
 * The CLI's check before it writes (`nexus ideas propose`): each item's refusal, if any (an unknown queue or entry, a
 * link that exists already or no longer, the same proposal waiting already). The server checks the same again.
 */
export function proposalIssues(store: ProjectStore, state: ProjectState, items: readonly IdeaLinkProposalItem[]): string[] {
  const { view, notes } = currentLinks(store, state);
  const file = store.readIdeaProposals();
  return items.flatMap((item, i) => {
    const name = `${item.op} ${item.queue} ${item.ref}${item.to ? ` → ${item.to}` : ""}`;
    const c = checkProposal(view, state, notes, item);
    if (!c.ok) return [`${name}: ${c.why}`];
    const twin = pendingSame(file, item) ?? (items.slice(0, i).some((x) => same(x, item)) ? { id: "this batch" } : undefined);
    return twin ? [`${name}: the same proposal waits for the user already (${twin.id})`] : [];
  });
}

/** Runs `run` under the proposals' lock (idea-proposals.lock); refused (409) while another write holds it. */
function withProposals<T>(store: ProjectStore, run: () => T): T {
  const lock = join(store.dir, "idea-proposals.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ActionError("Another save of the link proposals is in progress; retry the same request", 409);
    throw e;
  }
  try { return run(); } finally { closeSync(fd); unlinkSync(lock); }
}

type Proposed = Extract<Event, { type: "ideas.links_proposed" }>;

/**
 * The server's intake (main.ts's change pass, "idea link proposals"): the sessions' `ideas.links_proposed` events whose
 * id the file does not hold yet, each checked (the proposer's role; each item's queue and entries, the link's state, a
 * duplicate of a waiting one) and recorded: `pending`, `outdated` (the link's state no longer fits) or `refused`. Writes
 * only .nexus/idea-proposals.yaml, never a link or a status. Returns how many events it took in.
 */
export function takeInLinkProposals(store: ProjectStore, state: ProjectState): number {
  const known = new Set(store.readIdeaProposals().proposals.map((p) => p.event));
  const fresh: { e: Proposed; s: SessionFile }[] = [];
  for (const s of state.sessions) {
    if (!s.event_count) continue;
    for (const e of store.readEvents(s.id).entries) {
      if (e.type === "ideas.links_proposed" && e.session === s.id && !known.has(e.id)) fresh.push({ e, s });
    }
  }
  if (!fresh.length) return 0;
  return withProposals(store, () => {
    const file = store.readIdeaProposals();
    const taken = new Set(file.proposals.map((p) => p.event));
    const { view, notes } = currentLinks(store, state);
    const proposals = [...file.proposals];
    let count = 0;
    for (const { e, s } of fresh.sort((a, b) => a.e.at.localeCompare(b.e.at) || compareIds(a.e.id, b.e.id))) {
      if (taken.has(e.id)) continue;
      count++;
      const working = s.role === "worker" ? state.queues.find((q) => q.id === s.queue)?.steps.find((x) => x.status === "running")?.id : undefined;
      const by = proposerOf(store, s, working);
      e.items.forEach((item, n) => {
        const base: IdeaProposal = {
          id: `${e.id}/${n + 1}`, event: e.id, by: by ?? { session: s.id, role: "worker" }, at: e.at,
          ...(e.reason ? { batch_reason: e.reason } : {}), op: item.op, queue: item.queue, ref: item.ref,
          ...(item.to ? { to: item.to } : {}), reason: item.reason, ...(item.evidence?.length ? { evidence: item.evidence } : {}),
          state: "pending",
        };
        const refuse = (note: string, as: "refused" | "outdated" = "refused") => proposals.push({ ...base, state: as, decided: { at: now(), note } });
        if (!by) return refuse(PROPOSER_REFUSAL);
        const c = checkProposal(view, state, notes, item);
        if (!c.ok) return refuse(c.why!, c.refused ? "refused" : "outdated");
        const twin = proposals.find((p) => p.state === "pending" && same(p, base));
        if (twin) return refuse(`the same proposal waits for the user already (${twin.id})`);
        proposals.push(base);
      });
    }
    store.writeIdeaProposals({ ...file, proposals });
    return count;
  });
}

/** A proposal as the dashboard shows it: whether it applies now (checked again on every read), and what it would do. */
export interface IdeaProposalView extends IdeaProposal { valid: boolean; why?: string; mapping: string[] }
export interface IdeaProposalsResponse { revision: string; proposals: IdeaProposalView[] }

/** The revision of the proposals' decisions: a decision on a page of another revision is refused (409). */
const revisionOf = (file: IdeaProposalsFile) => ideaHash(file.proposals.map((p) => [p.id, p.state]));

/** Every proposal (refused ones too), each checked against the relationships as they stand. */
export function ideaProposals(store: ProjectStore, state: ProjectState): IdeaProposalsResponse {
  const file = store.readIdeaProposals();
  const { view, notes } = currentLinks(store, state);
  return {
    revision: revisionOf(file),
    proposals: file.proposals.map((p) => {
      if (p.state !== "pending" && p.state !== "outdated") return { ...p, valid: false, mapping: [] };
      const c = checkProposal(view, state, notes, p);
      return { ...p, valid: c.ok, ...(c.why ? { why: c.why } : {}), mapping: c.mapping };
    }),
  };
}

const DecideRequest = z.object({
  request_id: z.string().min(1).max(200), revision: z.string().min(1),
  decisions: z.array(z.object({ id: z.string().min(1), accept: z.boolean(), note: z.string().trim().min(1).optional() }).strict()).min(1),
}).strict();

/** The answer to the user's decisions: what was accepted (with its link action), declined, and found outdated. */
export interface IdeaProposalsDecision {
  request_id: string;
  accepted: { id: string; action: string }[];
  declined: string[];
  outdated: { id: string; why: string }[];
  message: string;
}

function answer(request_id: string, decided: readonly IdeaProposal[]): IdeaProposalsDecision {
  const accepted = decided.filter((p) => p.state === "accepted").map((p) => ({ id: p.id, action: p.decided!.action! }));
  const declined = decided.filter((p) => p.state === "declined").map((p) => p.id);
  const outdated = decided.filter((p) => p.state === "outdated").map((p) => ({ id: p.id, why: p.decided?.note ?? "" }));
  const parts = [
    ...(accepted.length ? [`${accepted.length} accepted`] : []),
    ...(declined.length ? [`${declined.length} declined`] : []),
    ...(outdated.length ? [`${outdated.length} outdated: ${[...new Set(outdated.map((o) => o.why))].join("; ")}`] : []),
  ];
  return { request_id, accepted, declined, outdated, message: parts.join("; ") };
}

/**
 * The user's decisions on proposals (the dashboard; one request for one item or a whole batch): each accepted item is
 * checked again (D8) and the valid ones are written together in one write of idea-matches.yaml, one link action each
 * (`actor: user`, the proposer's reason, `proposal: {id, by}`), so each can be undone alone (D9, D10); one that no
 * longer applies is left `outdated` with why. A declined one needs no reason. The same `request_id` again answers what
 * it did; a page of another revision is refused. Only the user: no CLI command and no event leads here.
 */
export function decideIdeaProposals(store: ProjectStore, input: unknown): IdeaProposalsDecision {
  const parsed = DecideRequest.safeParse(input);
  if (!parsed.success) throw new ActionError(`invalid decision on link proposals: ${parsed.error.message}`);
  const req = parsed.data;
  return withProposals(store, () => {
    const file = store.readIdeaProposals();
    const before = file.proposals.filter((p) => p.decided?.request === req.request_id);
    if (before.length) return answer(req.request_id, before);
    if (revisionOf(file) !== req.revision) throw new ActionError("Changed since you opened this; review the newer decision", 409);
    const byId = new Map(file.proposals.map((p) => [p.id, p]));
    const at = now();
    const decided = new Map<string, IdeaProposal>();
    for (const d of req.decisions) {
      const p = byId.get(d.id);
      if (!p) throw new ActionError(`no link proposal ${d.id}`, 404);
      if (p.state !== "pending" && p.state !== "outdated") throw new ActionError(`link proposal ${d.id} is ${p.state} already`, 409);
      if (decided.has(d.id)) throw new ActionError(`link proposal ${d.id} is named twice`);
      if (!d.accept) decided.set(d.id, { ...p, state: "declined", decided: { at, request: req.request_id, ...(d.note ? { note: d.note } : {}) } });
    }
    const accepts = req.decisions.filter((d) => d.accept);
    if (accepts.length) withIdeaLinks(store, (links) => {
      for (const d of accepts) {
        const p = byId.get(d.id)!;
        const outdated = (why: string) => decided.set(p.id, { ...p, state: "outdated", decided: { at, request: req.request_id, note: why } });
        // An action already written for it (a write of the links that the proposals' write did not follow): accepted.
        const done = links.file.history?.find((a) => a.proposal?.id === p.id);
        if (done) { decided.set(p.id, { ...p, state: "accepted", decided: { at, request: req.request_id, action: done.id } }); continue; }
        const c = checkProposal(links.view, links.state, links.notes, p);
        if (!c.ok) { outdated(c.why!); continue; }
        const id = `${req.request_id}:${p.id}`;
        try {
          const edit = linkEditor(links, `manual:${id}`);
          let operation: IdeaLinkAction["operation"];
          if (p.op === "add") { edit.add(p.queue, p.ref, p.reason); operation = "add"; }
          else {
            for (const r of c.origins) edit.unlink(edit.find(r.id));
            const source = c.origins[0]!.origin === "source";
            if (p.op === "replace") { edit.add(p.queue, p.to, p.reason); operation = source ? "correct-source" : "replace"; }
            else operation = c.origins.every((r) => r.origin === "source") ? "ignore-source" : "remove";
          }
          recordAction(links, { id, request: ideaHash({ request_id: req.request_id, proposal: p.id }), at: links.at, actor: "user",
            reason: p.reason, operation, changes: edit.changes, proposal: { id: p.id, by: p.by } });
          decided.set(p.id, { ...p, state: "accepted", decided: { at, request: req.request_id, action: id } });
        } catch (e) {
          if (!(e instanceof ActionError)) throw e;
          outdated(e.message);
        }
      }
    });
    store.writeIdeaProposals({ ...file, proposals: file.proposals.map((p) => decided.get(p.id) ?? p) });
    return answer(req.request_id, req.decisions.map((d) => decided.get(d.id)!));
  });
}

/** The user's decisions on proposals, one per request, oldest first: what the orchestrator is told (D11). */
export interface ProposalDecisionGroup { request: string; at: string; items: IdeaProposal[] }

export function proposalDecisions(store: ProjectStore): ProposalDecisionGroup[] {
  const groups = new Map<string, ProposalDecisionGroup>();
  for (const p of store.readIdeaProposals().proposals) {
    const request = p.decided?.request;
    if (!request) continue;
    const g = groups.get(request) ?? { request, at: p.decided!.at, items: [] };
    g.items.push(p);
    groups.set(request, g);
  }
  return [...groups.values()].sort((a, b) => a.at.localeCompare(b.at));
}

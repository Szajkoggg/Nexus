// The agents' idea-link proposals (queue IWS, part d): the server's intake into idea-proposals.yaml, which changes no
// link and no status, and the user's decisions, which write the accepted ones through the links' writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, PROPOSER_REFUSAL, ProjectStore, changeIdeaLinks, decideIdeaProposals, ideaLinks, ideaProposals, loadProjectState, newId, now,
  proposalDecisions, proposalIssues, reconcileIdeaStatuses, takeInLinkProposals, type Event, type IdeaLinkProposalItem, type Role,
} from "../src/index.ts";

const REF = "notes/a.md#2026-11-14", OTHER = "notes/a.md#2026-11-15";
const TEXT = "# A\n**Summary:** A summary.\n## Decided\n### 2026-11-14\n- First.\n### 2026-11-15\n- Other.\n";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "nexus-idea-proposals-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes/a.md"), TEXT);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "notes" } }));
  const queue = (id: string, extra: object = {}) => store.writeQueue({ protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "done",
    steps: [{ id: `${id}1`, title: "Work", goal: "Outcome", acceptance: [], status: "done" }], approvals: [], history: [], checks: [], stop_conditions: [], ...extra });
  queue("A", { source: [REF] });
  queue("B");
  queue("M", { maintenance: "survey" });
  const sessions: [string, Role, object][] = [["o", "orchestrator", {}], ["c", "conversation", { title: "Ideas chat" }], ["w", "worker", { queue: "B" }], ["m", "worker", { queue: "M" }]];
  for (const [id, role, extra] of sessions) store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: now(), ...extra });
  const propose = (session: string, items: IdeaLinkProposalItem[], reason?: string) => {
    const e = { v: 1, id: newId(), at: now(), session, type: "ideas.links_proposed", items, ...(reason ? { reason } : {}) } as Event;
    store.appendEvent(e);
    return e.id;
  };
  const intake = () => takeInLinkProposals(store, loadProjectState(store));
  const proposals = () => ideaProposals(store, loadProjectState(store));
  const decide = (decisions: { id: string; accept: boolean; note?: string }[], request_id = newId()) => decideIdeaProposals(store, { request_id, revision: proposals().revision, decisions });
  const links = () => ideaLinks(store, loadProjectState(store));
  const linked = (queue: string, ref: string) => links().items.some((r) => r.queue === queue && r.ref === ref && r.effective);
  const bytes = (name: string) => { const f = join(store.dir, name); return existsSync(f) ? readFileSync(f) : null; };
  const userLink = (body: object) => changeIdeaLinks(store, { request_id: newId(), revision: links().revision, reason: "The user's own", ...body });
  return { store, propose, intake, proposals, decide, links, linked, bytes, userLink };
}

const add = (queue: string, ref: string): IdeaLinkProposalItem => ({ op: "add", queue, ref, reason: `${queue} carries out ${ref}`, evidence: [`${queue} description: …`] });

test("a proposal: taken in as pending, idea-matches.yaml and idea-statuses.yaml stay byte for byte; accepted, it is a link with actor user, the proposal and its proposer", (t) => {
  const f = fixture(t);
  // Both files exist before: a link of the user's, and the statuses (as the server writes them).
  f.userLink({ operation: "add", queue: "M", ref: OTHER });
  f.store.writeIdeaStatuses({ protocol: 1, records: [], history: [], invalidations: [] });
  reconcileIdeaStatuses(f.store, loadProjectState(f.store));
  const matches = f.bytes("idea-matches.yaml"), statuses = f.bytes("idea-statuses.yaml");
  assert.ok(matches && statuses, "both files are there to compare");
  const event = f.propose("o", [add("B", REF)]);
  assert.equal(f.intake(), 1);
  assert.deepEqual(f.bytes("idea-matches.yaml"), matches, "a proposal writes no link");
  assert.deepEqual(f.bytes("idea-statuses.yaml"), statuses, "a proposal writes no status");
  assert.equal(f.linked("B", REF), false);
  const [p] = f.proposals().proposals;
  assert.equal(p!.id, `${event}/1`);
  assert.equal(p!.state, "pending");
  assert.deepEqual(p!.by, { session: "o", role: "orchestrator" });
  assert.equal(p!.valid, true);
  assert.deepEqual(p!.mapping, ["Adds a manual link."]);
  assert.equal(f.intake(), 0, "taken in once");
  const r = f.decide([{ id: p!.id, accept: true }]);
  assert.equal(r.message, "1 accepted");
  assert.equal(f.linked("B", REF), true);
  const action = f.links().history.at(-1)!;
  assert.equal(action.actor, "user");
  assert.equal(action.reason, "B carries out notes/a.md#2026-11-14", "the proposer's reason (D10)");
  assert.deepEqual(action.proposal, { id: p!.id, by: { session: "o", role: "orchestrator" } });
  assert.equal(r.accepted[0]!.action, action.id);
  assert.equal(f.proposals().proposals[0]!.state, "accepted");
  const told = proposalDecisions(f.store);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.items[0]!.state, "accepted");
});

test("a batch: the valid items are written together in one write, one action each, and each undoes alone", (t) => {
  const f = fixture(t);
  f.userLink({ operation: "add", queue: "B", ref: OTHER });
  const batch = f.propose("c", [
    add("M", REF),
    { op: "remove", queue: "A", ref: REF, reason: "A is about checkouts, not this entry" },
    { op: "replace", queue: "B", ref: OTHER, to: REF, reason: "B names the wrong date" },
  ], "From the notes survey's report");
  f.intake();
  const items = f.proposals().proposals;
  assert.deepEqual(items.map((p) => p.state), ["pending", "pending", "pending"]);
  assert.equal(items[0]!.batch_reason, "From the notes survey's report");
  assert.deepEqual(items[1]!.mapping, ["This is the queue's own source: ignores it (the queue file does not change)."]);
  assert.deepEqual(items[2]!.mapping, ["Changes the target."]);
  assert.deepEqual(items[0]!.by, { session: "c", role: "conversation", title: "Ideas chat" });
  const before = f.links().history.length;
  const r = f.decide(items.map((p) => ({ id: p.id, accept: true })));
  assert.equal(r.message, "3 accepted");
  const history = f.links().history;
  assert.equal(history.length, before + 3, "one action per item");
  assert.equal(new Set(history.slice(before).map((a) => a.at)).size, 1, "one write");
  assert.deepEqual(history.slice(before).map((a) => a.operation), ["add", "ignore-source", "replace"]);
  assert.deepEqual(history.slice(before).map((a) => a.proposal!.id), [`${batch}/1`, `${batch}/2`, `${batch}/3`]);
  assert.equal(f.linked("M", REF), true);
  assert.equal(f.linked("A", REF), false);
  assert.equal(f.linked("B", OTHER), false);
  assert.equal(f.linked("B", REF), true);
  // The removal of A's source undone alone: the others stay.
  f.userLink({ operation: "undo", action: history[before + 1]!.id });
  assert.equal(f.linked("A", REF), true);
  assert.equal(f.linked("M", REF), true);
  assert.equal(f.linked("B", REF), true);
});

test("an outdated proposal: checked again at acceptance, left outdated with why; the batch's valid one is written", (t) => {
  const f = fixture(t);
  f.propose("o", [add("B", REF), add("M", OTHER)]);
  f.intake();
  // The user links B to the entry by hand meanwhile: the first proposal no longer applies.
  f.userLink({ operation: "add", queue: "B", ref: REF });
  const [first, second] = f.proposals().proposals;
  assert.equal(first!.valid, false);
  assert.equal(first!.why, "this link already exists (a manual link)");
  const history = f.links().history.length;
  const r = f.decide([{ id: first!.id, accept: true }, { id: second!.id, accept: true }]);
  assert.equal(r.message, "1 accepted; 1 outdated: this link already exists (a manual link)");
  assert.deepEqual(r.outdated, [{ id: first!.id, why: "this link already exists (a manual link)" }]);
  assert.equal(f.links().history.length, history + 1, "only the valid one is written");
  assert.equal(f.proposals().proposals[0]!.state, "outdated");
  // An outdated one is dismissed with a decline; the intake marks one outdated at once when it already fails.
  assert.equal(f.decide([{ id: first!.id, accept: false }]).message, "1 declined");
  f.propose("o", [{ op: "remove", queue: "M", ref: REF, reason: "no such link" }]);
  f.intake();
  const late = f.proposals().proposals.at(-1)!;
  assert.equal(late.state, "outdated");
  assert.equal(late.decided?.note, "this link no longer exists");
});

test("a repeated proposal: the same event once, the same item waiting already refused, the same request answered again without a write", (t) => {
  const f = fixture(t);
  f.propose("o", [add("B", REF)]);
  f.propose("c", [add("B", REF)]);
  assert.equal(f.intake(), 2);
  assert.equal(f.intake(), 0);
  const [first, twin] = f.proposals().proposals;
  assert.equal(first!.state, "pending");
  assert.equal(twin!.state, "refused");
  assert.equal(twin!.decided?.note, `the same proposal waits for the user already (${first!.id})`);
  assert.deepEqual(proposalIssues(f.store, loadProjectState(f.store), [add("B", REF)]), [`add B ${REF}: the same proposal waits for the user already (${first!.id})`]);
  const request = newId();
  const once = f.decide([{ id: first!.id, accept: true }], request);
  const matches = f.bytes("idea-matches.yaml");
  const again = decideIdeaProposals(f.store, { request_id: request, revision: "old", decisions: [{ id: first!.id, accept: true }] });
  assert.deepEqual(again, once);
  assert.deepEqual(f.bytes("idea-matches.yaml"), matches, "no second write");
  assert.throws(() => f.decide([{ id: first!.id, accept: false }]), (e: unknown) => e instanceof ActionError && e.status === 409 && /accepted already/.test(e.message));
  assert.throws(() => decideIdeaProposals(f.store, { request_id: newId(), revision: "old", decisions: [{ id: first!.id, accept: false }] }),
    (e: unknown) => e instanceof ActionError && e.status === 409 && /Changed since you opened this/.test(e.message));
});

test("an unknown queue or entry, and a proposer without the right, are refused at intake and by the CLI's check", (t) => {
  const f = fixture(t);
  const unknown = [add("Z", REF), add("B", "notes/a.md#2026-11-20"), add("B", "notes/b.md#2026-11-14")];
  assert.deepEqual(proposalIssues(f.store, loadProjectState(f.store), unknown).map((x) => x.replace(/:.*?: /, ": ")), [
    `add Z ${REF}: queue Z does not exist`,
    "add B notes/a.md#2026-11-20: notes/a.md has no Decided entry of 2026-11-20 (its dates: 2026-11-14, 2026-11-15)",
    "add B notes/b.md#2026-11-14: there is no note notes/b.md",
  ]);
  f.propose("o", unknown);
  f.propose("w", [add("B", REF)]);
  f.propose("m", [add("M", REF)]);
  f.intake();
  const all = f.proposals().proposals;
  assert.deepEqual(all.map((p) => p.state), ["refused", "refused", "refused", "refused", "pending"]);
  assert.equal(all[0]!.decided?.note, "queue Z does not exist");
  assert.equal(all[3]!.decided?.note, PROPOSER_REFUSAL, "a worker of an ordinary queue may not propose");
  assert.deepEqual(all[4]!.by, { session: "m", role: "worker", queue: "M" }, "a maintenance queue's worker may");
  assert.equal(proposalDecisions(f.store).length, 0, "refusals at intake are no decision of the user's");
  assert.throws(() => f.decide([{ id: all[0]!.id, accept: true }]), (e: unknown) => e instanceof ActionError && e.status === 409 && /refused already/.test(e.message));
});

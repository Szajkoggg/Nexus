// A step's review decisions (queue RVD; docs/protocol/review.md, "Review decisions"; the design in
// docs/design/review-decisions.md): the list its worker declares before step.done (or an explicit none), the
// orchestrator's additions, the answers by version and round, and the one rule that holds every acceptance until the
// list is complete. Pure: state.ts applies the events here and every acceptance path asks decisionGate.
import { awayAt } from "./away.ts";
import type { AwayFile, DecisionOption, Event } from "./schemas.ts";

type Of<T extends Event["type"]> = Extract<Event, { type: T }>;
type Away = Pick<AwayFile, "current" | "past">;

/** One answer to a decision: the version and round it answers, by whom; `provisional` the orchestrator's to a user decision. */
export interface DecisionAnswer {
  event: string; at: string; session: string; by: "user" | "orchestrator" | "helper";
  version: number; round: number; choice?: string; text?: string; provisional?: true;
}

export interface DecisionView {
  id: string;
  /** 1, then one more at each declaration of the id, and at review material added under a key or path it names. */
  version: number;
  /** The review round it was declared in (its latest version's). */
  round: number;
  text: string; options: DecisionOption[]; recommended?: string; material: string[]; why?: string;
  for: "user" | "reviewer";
  by: "worker" | "orchestrator";
  at: string;
  withdrawn?: { text: string; at: string; by: "worker" | "orchestrator" };
  /** What made each version, oldest first. */
  versions: { version: number; at: string; by: "worker" | "orchestrator" | "material"; event: string }[];
  /** Every valid answer, oldest first: those of earlier versions and rounds are its history. */
  answers: DecisionAnswer[];
}

/**
 * A step's decision list. `none`: the explicit statement that nothing is to be decided (cleared when a decision is
 * added). `legacy`: the latest step.done came before the project's `review_decisions_since`, or the project has no such
 * mark: a list is not required (one declared anyway counts).
 */
export interface DecisionsView {
  items: DecisionView[];
  none?: { text: string; at: string; by: "worker" | "orchestrator"; round: number };
}

/** What the list is: declared (with decisions, also all withdrawn), none, not required (legacy), or missing. */
export type ListState = "declared" | "none" | "legacy" | "missing";

/** Who accepts, for decisionGate: a provisional acceptance is the orchestrator's at level 3 (or 2 while away). */
export type Acceptor = "user" | "orchestrator" | "helper" | "nexus" | "provisional";

/** The step's fields the decisions need. */
interface DecisionStep {
  id: string; status: string; level: number; session?: string; review_with?: "orchestrator" | "user";
  decisions: DecisionsView; timeline: readonly Event[];
}

export const emptyDecisions = (): DecisionsView => ({ items: [] });

/** The decisions still on the list. */
export const activeDecisions = (d: DecisionsView): DecisionView[] => d.items.filter((x) => !x.withdrawn);

/** The list's state: `since` the project's review_decisions_since; `done` the latest step.done's time. */
export function listState(d: DecisionsView, since: string | undefined, done: string | undefined): ListState {
  if (d.items.length) return "declared";
  if (d.none) return "none";
  return !since || (done !== undefined && done < since) ? "legacy" : "missing";
}

/** The answer that counts now: the latest to the decision's current version in the review round `round`. */
export function currentAnswer(d: DecisionView, round: number): DecisionAnswer | undefined {
  return d.answers.findLast((a) => a.version === d.version && a.round === round);
}

/** An answer that chose an option marked `fix` (the work must change): no acceptance with it. */
export const asksFix = (d: Pick<DecisionView, "options">, a: DecisionAnswer | undefined): boolean =>
  !!a?.choice && d.options.some((o) => o.label === a.choice && o.effect === "fix");

/** Why one decision does not let `acceptor` accept, or undefined when it does. */
function openReason(d: DecisionView, round: number, acceptor: Acceptor): string | undefined {
  const a = currentAnswer(d, round);
  if (!a) {
    const older = d.answers.findLast((x) => x.round === round);
    return older ? "the question changed since its answer" : "not answered";
  }
  if (asksFix(d, a)) return `the answer "${a.choice}" asks for a change`;
  if (d.for === "reviewer" || a.by === "user") return undefined;
  if (acceptor === "provisional" && a.provisional) return undefined;
  return acceptor === "user" ? "the orchestrator's answer is a proposal: answer it yourself" : "the user's to answer";
}

/** The decisions that hold `acceptor`'s acceptance, each with why. */
export function openDecisions(d: DecisionsView, round: number, acceptor: Acceptor): { id: string; why: string }[] {
  return activeDecisions(d).flatMap((x) => { const why = openReason(x, round, acceptor); return why ? [{ id: x.id, why }] : []; });
}

/**
 * Why the step may not be accepted by `acceptor` now, or undefined when it may (docs/protocol/review.md, "Review
 * decisions"): every decision on the list needs a current answer someone allowed gave (a user decision the user's
 * own, or for a provisional acceptance the orchestrator's), none asking for a change; a missing list holds the
 * reviewers (orchestrator, review helper, provisional), not the user or Nexus. The same rule for the server's actions
 * and the derivation of every acceptance event.
 */
export function decisionGate(st: Pick<DecisionStep, "decisions">, round: number, acceptor: Acceptor, list: ListState): string | undefined {
  if (list === "missing" && (acceptor === "orchestrator" || acceptor === "helper" || acceptor === "provisional")) {
    return "the step has no decision list: declare its decisions, or that it has none, before accepting it";
  }
  const open = openDecisions(st.decisions, round, acceptor);
  if (!open.length) return undefined;
  return `${open.length} decision${open.length === 1 ? " is" : "s are"} open: ${open.map((o) => `${o.id} (${o.why})`).join(", ")}`;
}

// ---------------------------------------------------------------- derivation (state.ts)

/** The context of a decision event: the writer's role, the review round at work or in review, the user's away periods. */
export interface DecisionContext {
  role: string | undefined;
  /** The step's review round (reviewRound): in review the current one; at work the one its step.done will end. */
  reviewRound: number;
  away: Away;
  /** Why a review helper's verdict does not count (helperRefusal), for a helper. */
  helperRefusal?: string;
  reviewedByOrchestrator: boolean;
}

const atWork = (st: Pick<DecisionStep, "status">) => st.status === "running" || st.status === "waiting";

/** Who may write the list now, or why not: the step's own worker while it works, the orchestrator while it holds the review. */
function listWriter(st: DecisionStep, e: Event, c: DecisionContext): { by: "worker" | "orchestrator"; round: number } | string {
  if (c.role === "worker") {
    if (e.session !== st.session) return `session ${e.session} is not the worker of step ${st.id}`;
    if (!atWork(st)) return `step ${st.id} is not at work: its worker declares its decisions before step.done`;
    return { by: "worker", round: c.reviewRound + 1 };
  }
  if (c.role === "orchestrator") {
    if (!c.reviewedByOrchestrator) return `step ${st.id} is not waiting for the orchestrator's review`;
    return { by: "orchestrator", round: c.reviewRound };
  }
  return "only the step's worker or the orchestrator writes a decision list";
}

/** A review.decision: a new decision, a new version of one, or its withdrawal. Returns a warning when it does not count. */
export function applyDecision(st: DecisionStep, e: Of<"review.decision">, c: DecisionContext): string | undefined {
  const w = listWriter(st, e, c);
  if (typeof w === "string") return w;
  const d = st.decisions;
  const old = d.items.find((x) => x.id === e.decision);
  if (old?.withdrawn) return `decision ${e.decision} of step ${st.id} was withdrawn; its id is not used again`;
  if (e.withdrawn !== undefined) {
    if (!old) return `step ${st.id} has no decision ${e.decision} to withdraw`;
    old.withdrawn = { text: e.withdrawn, at: e.at, by: w.by };
    return undefined;
  }
  const labels = e.options.map((o) => o.label);
  if (new Set(labels).size !== labels.length) return `decision ${e.decision} of step ${st.id} names an option twice`;
  // Only the user's answer settles a user's decision: the orchestrator raises one to the user, never lowers it.
  if (old && old.for === "user" && e.for === "reviewer" && w.by === "orchestrator") return `decision ${e.decision} of step ${st.id} is the user's; the orchestrator does not make it a reviewer's`;
  let warn: string | undefined;
  const recommended = e.recommended === undefined ? undefined : labels.includes(e.recommended) ? e.recommended : undefined;
  if (e.recommended !== undefined && !recommended) warn = `decision ${e.decision} of step ${st.id}: the recommendation "${e.recommended}" is not one of its options; dropped`;
  const version = (old?.version ?? 0) + 1;
  const fields = {
    version, round: w.round, text: e.text, options: e.options.map((o) => ({ ...o })), material: [...(e.material ?? [])],
    for: e.for, by: w.by, at: e.at, ...(recommended ? { recommended } : {}), ...(e.why ? { why: e.why } : {}),
  };
  if (old) {
    delete old.recommended; delete old.why;
    Object.assign(old, fields);
    old.versions.push({ version, at: e.at, by: w.by, event: e.id });
  } else {
    d.items.push({ id: e.decision, ...fields, versions: [{ version, at: e.at, by: w.by, event: e.id }], answers: [] });
  }
  d.none = undefined;
  return warn ? `event ${e.id}: ${warn}` : undefined;
}

/** A review.decisions_none: the step has nothing to decide. */
export function applyNone(st: DecisionStep, e: Of<"review.decisions_none">, c: DecisionContext): string | undefined {
  const w = listWriter(st, e, c);
  if (typeof w === "string") return w;
  const left = activeDecisions(st.decisions);
  if (left.length) return `step ${st.id} has ${left.length} decision${left.length === 1 ? "" : "s"} on its list (${left.map((x) => x.id).join(", ")}): withdraw them first`;
  st.decisions.none = { text: e.text, at: e.at, by: w.by, round: w.round };
  return undefined;
}

/**
 * A review.decided: valid in the step's review, for the decision's current version and the current round, from someone
 * allowed at the answer's time: the user always; the orchestrator while it holds the review, a user's decision only at
 * level 3 or at level 2 while the user was away (provisional); a review helper of the round, a reviewer's decision only.
 */
export function applyAnswer(st: DecisionStep, e: Of<"review.decided">, c: DecisionContext): string | undefined {
  if (st.status !== "review") return `step ${st.id} is not in its review`;
  const d = st.decisions.items.find((x) => x.id === e.decision);
  if (!d) return `step ${st.id} has no decision ${e.decision}`;
  if (d.withdrawn) return `decision ${e.decision} of step ${st.id} was withdrawn`;
  if (e.version !== d.version) return `the answer is to version ${e.version} of decision ${e.decision}, which is at version ${d.version}`;
  if (e.round !== c.reviewRound) return `the answer is for review round ${e.round} of step ${st.id}, which is at round ${c.reviewRound}`;
  if (e.choice !== undefined && !d.options.some((o) => o.label === e.choice)) return `"${e.choice}" is not an option of decision ${e.decision}`;
  let provisional = false;
  const by = c.role === "user" ? "user" : c.role === "helper" ? "helper" : c.role === "orchestrator" ? "orchestrator" : undefined;
  if (!by) return "a decision is answered by the user, the orchestrator or a review helper";
  if (by === "helper") {
    if (c.helperRefusal) return c.helperRefusal;
    if (d.for === "user") return `decision ${e.decision} is the user's: a review helper answers only a reviewer's decision`;
  }
  if (by === "orchestrator") {
    if (!c.reviewedByOrchestrator) return `step ${st.id} is not waiting for the orchestrator's review`;
    if (d.for === "user") {
      if (st.level !== 3 && !(st.level === 2 && awayAt(c.away, e.at))) return `decision ${e.decision} is the user's and step ${st.id} is at review level ${st.level}${st.level === 2 ? " with away mode off" : ""}: hand it to the user`;
      provisional = true;
    }
  }
  const text = e.text?.trim() ? e.text : undefined;
  d.answers.push({
    event: e.id, at: e.at, session: e.session, by, version: e.version, round: e.round,
    ...(e.choice !== undefined ? { choice: e.choice } : {}), ...(text ? { text } : {}), ...(provisional ? { provisional: true as const } : {}),
  });
  return undefined;
}

/** Review material added in the review under a key or path a decision names: a new version of that decision. */
export function applyMaterial(st: DecisionStep, e: Of<"review.added">): void {
  if (st.status !== "review") return;
  const named = new Set(e.items.flatMap((i) => [i.key, i.path, i.url].filter((x): x is string => !!x)));
  for (const d of activeDecisions(st.decisions)) {
    if (!d.material.some((m) => named.has(m))) continue;
    d.version++;
    d.versions.push({ version: d.version, at: e.at, by: "material", event: e.id });
  }
}

/**
 * The review helper hands the step's user decisions to the user (its review.asked_user): only while some decision is
 * the user's and every reviewer's decision has a current answer.
 */
export function helperHandOverRefusal(st: Pick<DecisionStep, "decisions">, round: number): string | undefined {
  const active = activeDecisions(st.decisions);
  if (!active.some((d) => d.for === "user")) return "a review helper hands a step to the user only for the user's decisions";
  const open = active.filter((d) => d.for === "reviewer" && !currentAnswer(d, round));
  return open.length ? `the reviewer's decisions ${open.map((d) => d.id).join(", ")} are not answered yet` : undefined;
}

// ---------------------------------------------------------------- text (nexus status, the notices, the packet, openings)

/** Who may answer a decision now: the step's level, the user's away mode now, whether the user took the review. */
export interface RightsNow { level: number; away: boolean; toUser: boolean }

/**
 * Who answers the decision now, as the notices and the packet say it (docs/design/review-decisions.md, "Rights: who
 * answers what"). A reviewer's decision: the review helper, the orchestrator, the user; a user's: the user, or at level 3
 * (2 while away) the orchestrator provisionally.
 */
function answerRights(d: Pick<DecisionView, "for">, r: RightsNow): string {
  if (r.toUser || r.level === 1) return "only the user answers it now";
  if (d.for === "reviewer") return "a reviewer's: the review helper or the orchestrator answers it (the user may answer it too)";
  return r.level === 3 || r.away
    ? "the user's: the orchestrator answers it provisionally, with why; the user confirms it on their return"
    : "the user's: only the user answers it (hand it over: nexus review ask-user)";
}

const answerText = (a: DecisionAnswer) =>
  `${a.choice ? `"${a.choice}"` : "none of the options"}${a.text ? `: ${a.text}` : ""} (${a.by === "helper" ? "the review helper" : `the ${a.by}`}${a.provisional ? ", provisional" : ""})`;

/** One decision's state in round `round`, in words: its current answer, or why it is open. */
function decisionState(d: DecisionView, round: number): string {
  const a = currentAnswer(d, round);
  if (a) return `answered ${answerText(a)}${asksFix(d, a) ? "; it asks for a change" : ""}`;
  const older = d.answers.findLast((x) => x.round === round);
  if (older) return `open: answered for an earlier version (${older.choice ? `"${older.choice}"` : "words"}); the question changed`;
  const earlier = d.answers.findLast((x) => x.round < round);
  return `open${earlier ? ` (round ${earlier.round}: ${answerText(earlier)})` : ""}`;
}

/**
 * The decision list as lines, for nexus status, the orchestrator's review notice and the review helper's packet: each
 * decision (id, version, whose, the question, options with the recommendation and those asking a change, material,
 * why), its state and who answers it; a missing list said as such. `rights` undefined: who answers is left out.
 */
export function decisionLines(d: DecisionsView, list: ListState, round: number, rights?: RightsNow): string[] {
  if (list === "missing") return ["The worker declared no decision list: declare its decisions (nexus decide) or that it has none (nexus decide <step> --none \"why\") before accepting it."];
  if (list === "legacy" && !d.items.length) return [];
  if (d.none && !activeDecisions(d).length) return [`No decisions (declared by the ${d.none.by}): ${d.none.text}`];
  return activeDecisions(d).map((x) => {
    const options = x.options.map((o) => `"${o.label}"${o.label === x.recommended ? " (recommended)" : ""}${o.effect === "fix" ? " (asks for a change)" : ""}`).join(", ");
    return [
      `${x.id} (version ${x.version}, ${x.for === "user" ? "the user's" : "a reviewer's"}, by the ${x.by}): ${x.text}`,
      `  options: ${options}`,
      ...(x.material.length ? [`  material: ${x.material.join(", ")}`] : []),
      ...(x.why ? [`  why it matters: ${x.why}`] : []),
      `  ${decisionState(x, round)}${rights ? `; ${answerRights(x, rights)}` : ""}`,
    ].join("\n");
  });
}

/** "2 decisions, 1 open (D2)", or undefined for a step with no decision on its list. */
export function decisionsCount(d: DecisionsView, round: number): string | undefined {
  const active = activeDecisions(d);
  if (!active.length) return undefined;
  const open = active.filter((x) => !currentAnswer(x, round));
  return `${active.length} decision${active.length === 1 ? "" : "s"}, ${open.length ? `${open.length} open (${open.map((x) => x.id).join(", ")})` : "all answered"}`;
}

/**
 * The answers a step's accepted review settled (its final round's current answers), for the next steps' openings: the
 * decision, its question, the answer and who gave it; `confirmation`: whether the user confirmed the step's
 * provisional acceptance yet (left out: the answers are said as given, as in a send-back).
 */
export function settledDecisions(d: DecisionsView, round: number, confirmation?: "pending" | "confirmed"): string[] {
  return activeDecisions(d).flatMap((x) => {
    const a = currentAnswer(x, round);
    if (!a) return [];
    const mark = !a.provisional ? "" : confirmation === "pending" ? ", provisional: the user has not confirmed it yet" : confirmation === "confirmed" ? ", confirmed by the user" : ", provisional";
    const who = a.by === "user" ? "the user" : `${a.by === "helper" ? "the review helper" : "the orchestrator"}${mark}`;
    return [`${x.id} "${x.text}": ${a.choice ? `"${a.choice}"` : "none of the options"}${a.text ? ` (${a.text})` : ""}, by ${who}`];
  });
}

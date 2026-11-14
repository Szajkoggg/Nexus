// The agent standards (queue AS): step summaries, questions, refused actions, a clean tree per step. Each is in the
// briefings where it concerns the agent, in a few lines with the pointer to its nexus help topic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKER_BRIEFING, orchestratorBriefing, partnerBriefing } from "../src/prompts.ts";

const orchestrator = orchestratorBriefing("P", 60);
const partner = partnerBriefing({ name: "P", root: "C:/p" } as Parameters<typeof partnerBriefing>[0], "Dev/Notes");
const has = (text: string, ...parts: string[]) => { for (const p of parts) assert.ok(text.includes(p), `missing: ${p}`); };

test("the step summary's shape: the worker writes it, the orchestrator reads it so", () => {
  has(WORKER_BRIEFING, "A step summary (nexus step done --summary) has four parts: what changed; how it was verified; what was left out or differs from the plan; what comes next, if anything.", "`nexus help summaries`");
  has(orchestrator, "a step summary has four parts (what changed; how it was verified; what was left out or differs from the plan; what comes next)", "`nexus help summaries`");
});

test("the question's shape: the worker asks so, the orchestrator reads and escalates so", () => {
  has(WORKER_BRIEFING, "A question (nexus ask) has three: what it blocks; the options; your recommendation.", "`nexus help questions`");
  has(orchestrator, "a question three (what it blocks; the options; the worker's recommendation)", "When you escalate a question, keep the same shape: your framing, the options, your recommendation.", "`nexus help questions`");
});

test("a refused action: no workaround, one simpler retry at most, then report; for every agent", () => {
  for (const [who, text] of [["worker", WORKER_BRIEFING], ["orchestrator", orchestrator], ["partner", partner]] as const) {
    assert.match(text, /When an action is refused, do not work around it through another tool or command that reaches the same end/, who);
    assert.match(text, /retry once in a simpler form at most/, who);
    assert.match(text, /what you needed and why/, who);
    assert.match(text, /`nexus help refusals`/, who);
  }
});

test("a clean working tree at every step's end, and the commit named", () => {
  has(WORKER_BRIEFING, "Leave the working tree clean at every step's end, not only at a stop: commit everything the step did (only its own files, by name) and name the commit with nexus step done --commit, so every commit belongs to exactly one step.", "`nexus help commits`");
  has(WORKER_BRIEFING, "Before you stop (nexus stop, or a stop condition you meet): commit what is in a consistent state"); // the stop rule stays
  has(orchestrator, "every step ends with a clean tree and names its commit");
});

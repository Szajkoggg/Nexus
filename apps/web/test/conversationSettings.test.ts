// A conversation's model and effort editor (queue CM; docs/ux/conversation-settings.md): the summary's running and
// next pairs with their defaults marked, the efforts filtered by the model the draft would run (also an inherited
// one), an effort that model does not take holding Save back, and the one PATCH that writes both fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationSettings, ModelInfo } from "@nexus/protocol";
import { changed, defaultLabel, draftOf, effortCheck, patchBody, summaryOf } from "../src/conversationSettings.ts";

const MODELS: ModelInfo[] = [
  { value: "gpt-6", label: "gpt-6", efforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-6-luna", label: "gpt-6-luna", efforts: ["low", "medium"] },
  { value: "gpt-6-plain", label: "gpt-6-plain" },
];
const fromProject = { model: "gpt-6", effort: "medium", model_from: "project", effort_from: "project" } as const;
const fromRuntime = { model: null, effort: null, model_from: "runtime", effort_from: "runtime" } as const;

const settings = (over: Partial<ConversationSettings>): ConversationSettings =>
  ({ running: null, next: { ...fromProject }, changes: false, inherited: fromProject, ...over });

test("the summary: the next pair with its defaults marked; the running pair beside it only while a reply runs on another", () => {
  assert.deepEqual(summaryOf(settings({}), false), { next: "gpt-6 (default) · medium (default)" });
  const own = settings({ next: { model: "gpt-6", effort: "high", model_from: "own", effort_from: "own" } });
  assert.deepEqual(summaryOf(own, false), { next: "gpt-6 · high" });
  const pending = settings({
    running: { model: "gpt-6", effort: "high" }, changes: true,
    next: { model: "gpt-6-luna", effort: "medium", model_from: "own", effort_from: "project" },
  });
  assert.deepEqual(summaryOf(pending, true), { running: "gpt-6 · high", next: "gpt-6-luna · medium (default)" });
  assert.deepEqual(summaryOf(pending, false), { next: "gpt-6-luna · medium (default)" }, "idle: the change applies from the next reply");
  assert.deepEqual(summaryOf(settings({ next: { ...fromRuntime }, inherited: fromRuntime }), false), { next: "Runtime default · Runtime default" });
});

test("the selectors' default choices name the inherited value, or the runtime's default when it is not known", () => {
  assert.equal(defaultLabel("gpt-6"), "Default (gpt-6)");
  assert.equal(defaultLabel(null), "Runtime default");
});

test("efforts follow the model the draft would run, its own or the inherited one", () => {
  assert.deepEqual(effortCheck("codex", MODELS, { model: "", effort: "" }, fromProject), { efforts: ["low", "medium", "high", "xhigh"] });
  assert.deepEqual(effortCheck("codex", MODELS, { model: "gpt-6-luna", effort: "" }, fromProject), { efforts: ["low", "medium"] });
  const luna = { ...fromProject, model: "gpt-6-luna" };
  assert.deepEqual(effortCheck("codex", MODELS, { model: "", effort: "low" }, luna).efforts, ["low", "medium"], "an inherited model filters too");
});

test("an effort the model does not take holds Save back, also an inherited one; a level it takes or the default clears it", () => {
  const own = effortCheck("codex", MODELS, { model: "gpt-6-luna", effort: "high" }, fromProject);
  assert.match(own.issue!, /gpt-6-luna takes effort low, medium/);
  const inherited = effortCheck("codex", MODELS, { model: "gpt-6-luna", effort: "" }, { ...fromProject, effort: "xhigh" });
  assert.match(inherited.issue!, /takes effort low, medium/, "the inherited effort is checked against the chosen model");
  assert.equal(effortCheck("codex", MODELS, { model: "gpt-6-luna", effort: "low" }, fromProject).issue, undefined);
  assert.equal(effortCheck("codex", MODELS, { model: "gpt-6-luna", effort: "" }, fromProject).issue, undefined, "the inherited medium fits");
});

test("an unknown model or default model: the runtime's levels, with a note instead of a verdict", () => {
  const noDefault = effortCheck("codex", MODELS, { model: "", effort: "high" }, fromRuntime);
  assert.deepEqual(noDefault.efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(noDefault.issue, undefined);
  assert.match(noDefault.note!, /default model is not known/);
  const plain = effortCheck("codex", MODELS, { model: "gpt-6-plain", effort: "high" }, fromProject);
  assert.equal(plain.issue, undefined);
  assert.match(plain.note!, /does not name the efforts of gpt-6-plain/);
  assert.deepEqual(effortCheck("claude", undefined, { model: "", effort: "" }, fromRuntime).efforts, ["low", "medium", "high", "xhigh", "max"], "no list yet");
});

test("one PATCH writes both fields, an inherited one cleared; the draft opens on the saved values", () => {
  assert.deepEqual(patchBody({ model: "gpt-6-luna", effort: "" }), { model: "gpt-6-luna", effort: null });
  assert.deepEqual(patchBody({ model: "", effort: "" }), { model: null, effort: null }, "Use defaults");
  assert.deepEqual(draftOf({ model: "gpt-6", effort: undefined }), { model: "gpt-6", effort: "" });
  assert.equal(changed({ model: "gpt-6", effort: "" }, { model: "gpt-6" }), false);
  assert.equal(changed({ model: "", effort: "" }, { model: "gpt-6" }), true);
});

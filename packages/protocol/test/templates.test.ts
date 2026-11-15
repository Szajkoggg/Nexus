// Queue templates (templates.ts): the three layers, filling the placeholders, and Nexus's shipped templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ProjectStore, applyDraft, loadProjectState } from "../src/index.ts";
import {
  TemplateError, fillTemplate, filledTemplateYaml, mergeTemplates, parseTemplate, readTemplateDir, readTemplates,
  shippedTemplatesDir, templateQueueId, type Template,
} from "../src/templates.ts";

const TEXT = `template:
  id: fix
  title: A fix
params:
  - name: issue
    description: what goes wrong
  - name: area
    description: where
    default: the engine
title: "Fix {{issue}}"
description: "In {{ area }}: {{issue}}"
steps:
  - id: "{{id}}1"
    title: "Fix {{issue}}"
    goal: Fix {{issue}} in {{area}}.
    acceptance: ["{{issue}} no longer happens"]
`;

const parse = (text = TEXT, layer: Template["layer"] = "nexus", path = "fix.yaml") => parseTemplate(text, layer, path);

test("filling: every placeholder in the texts, the id first, defaults where nothing is given", () => {
  const q = fillTemplate(parse(), { issue: "a crash" }, "F");
  assert.deepEqual(Object.keys(q)[0], "id");
  assert.equal(q.id, "F");
  assert.equal(q.title, "Fix a crash");
  assert.equal(q.description, "In the engine: a crash");
  const [step] = q.steps as { id: string; goal: string; acceptance: string[] }[];
  assert.equal(step!.id, "F1");
  assert.equal(step!.goal, "Fix a crash in the engine.");
  assert.deepEqual(step!.acceptance, ["a crash no longer happens"]);
  assert.equal(q.template, undefined);
  assert.equal(q.params, undefined);
  // A given value replaces the default; a value is put in as it is, braces and all.
  const q2 = fillTemplate(parse(), { issue: "{{area}} breaks", area: "the CLI" }, "G");
  assert.equal(q2.description, "In the CLI: {{area}} breaks");
});

test("a missing parameter without a default is refused, naming it and what it means", () => {
  assert.throws(() => fillTemplate(parse(), {}, "F"), (e: Error) => e instanceof TemplateError && /needs issue \(what goes wrong\)/.test(e.message) && /--set/.test(e.message));
  assert.throws(() => fillTemplate(parse(), { issue: "x", nope: "y" }, "F"), /has no parameter nope \(its parameters: issue, area\)/);
  assert.throws(() => fillTemplate(parse(), { issue: "x", id: "y" }, "F"), /--id/);
  assert.throws(() => fillTemplate(parse(), { issue: "x" }, "bad id!"), /queue id/);
});

test("a placeholder that would stay unfilled is an error: when the template is read, and when it is filled", () => {
  const stray = TEXT.replace("goal: Fix {{issue}} in {{area}}.", "goal: Fix {{issue}} by {{deadline}}.");
  assert.throws(() => parse(stray), (e: Error) => e instanceof TemplateError && /would stay unfilled: \{\{deadline\}\}/.test(e.message));
  // A template made in code without the parse checks: filling still refuses to leave it.
  const t = { ...parse(), queue: { ...parse().queue, title: "{{deadline}}" } };
  assert.throws(() => fillTemplate(t, { issue: "x" }, "F"), /left unfilled: \{\{deadline\}\}/);
});

test("a template file is refused with the reason: no header, a bad or repeated parameter, an id parameter, no steps", () => {
  assert.throws(() => parse("title: x\nsteps: [{id: A, title: a, goal: g}]\n"), /template:/);
  assert.throws(() => parse(TEXT.replace("id: fix", "id: Fix It")), /template id/);
  assert.throws(() => parse(TEXT.replace("name: area", "name: issue")), /issue declared more than once/);
  assert.throws(() => parse(TEXT.replace("name: area", "name: id")), /queue's id/);
  assert.throws(() => parse(TEXT.replace(/steps:[\s\S]*/, "steps: []\n")), /at least one step/);
  assert.throws(() => parse("template: [unclosed"), /not valid YAML/);
});

test("three layers: for the same id the project's wins over the global one, which wins over Nexus's", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-templates-"));
  const dirs = { nexus: join(root, "nexus"), global: join(root, "global") };
  const project = join(root, "project");
  const write = (dir: string, file: string, id: string, title: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), TEXT.replace("id: fix", `id: ${id}`).replace("title: A fix", `title: ${title}`));
  };
  write(dirs.nexus, "fix.yaml", "fix", "Nexus's fix");
  write(dirs.nexus, "spike.yaml", "spike", "Nexus's spike");
  write(dirs.nexus, "other.yaml", "other", "Nexus's other");
  write(dirs.global, "fix.yaml", "fix", "My fix");
  write(dirs.global, "spike.yaml", "spike", "My spike");
  write(join(project, "nexus-templates"), "fix.yml", "fix", "The project's fix");
  writeFileSync(join(dirs.global, "broken.yaml"), "title: no header\n");
  writeFileSync(join(dirs.global, "notes.txt"), "not a template");

  const all = readTemplates(project, dirs);
  const by = Object.fromEntries(all.templates.map((t) => [t.id, t]));
  assert.deepEqual(all.templates.map((t) => t.id), ["fix", "other", "spike"]);
  assert.equal(by.fix!.title, "The project's fix");
  assert.equal(by.fix!.layer, "project");
  assert.deepEqual(by.fix!.replaces, ["nexus", "global"]);
  assert.equal(by.spike!.title, "My spike");
  assert.deepEqual(by.spike!.replaces, ["nexus"]);
  assert.equal(by.other!.layer, "nexus");
  assert.deepEqual(all.problems.map((p) => [p.layer, p.path.endsWith("broken.yaml")]), [["global", true]]);
  // Without a project only Nexus's and the user's.
  assert.equal(readTemplates(undefined, dirs).templates.find((t) => t.id === "fix")!.title, "My fix");
  // Two files of one layer with the same id: the first by path is used, the other is a problem.
  write(dirs.global, "fix2.yaml", "fix", "My other fix");
  const twice = mergeTemplates(readTemplateDir(dirs.global, "global"));
  assert.equal(twice.templates.find((t) => t.id === "fix")!.title, "My fix");
  assert.ok(twice.problems.some((p) => p.path.endsWith("fix2.yaml") && /also in/.test(p.problem)));
});

test("a free queue id from the template's id, numbered when taken", () => {
  assert.equal(templateQueueId({ id: "ui-change" }, () => false), "UICHANGE");
  const taken = new Set(["BUGFIX", "BUGFIX2"]);
  assert.equal(templateQueueId({ id: "bugfix" }, (x) => taken.has(x)), "BUGFIX3");
});

/** Values for each shipped template's required parameters. */
const VALUES: Record<string, Record<string, string>> = {
  bugfix: { issue: "the list crashes when empty", area: "the dashboard" },
  "ui-change": { change: "a count beside each project", view: "project-rail" },
  spike: { question: "Can the CLI start faster?" },
  refactor: { target: "store.ts", reason: "smaller functions" },
  maintenance: {},
};

test("Nexus's five shipped templates, each filled, are valid queues the draft path accepts", () => {
  const { templates, problems } = readTemplates(undefined, { nexus: shippedTemplatesDir(), global: join(tmpdir(), "nexus-no-such-dir") });
  assert.deepEqual(problems, []);
  assert.deepEqual(templates.map((t) => t.id).sort(), Object.keys(VALUES).sort());
  const root = mkdtempSync(join(tmpdir(), "nexus-shipped-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const t of templates) {
    const id = templateQueueId(t, () => false);
    const queue = fillTemplate(t, VALUES[t.id]!, id);
    // Through the YAML the CLI writes, as an orchestrator would upload it.
    const definition = YAML.parse(filledTemplateYaml(t, queue, `.nexus/drafts/${id}.yaml`));
    assert.deepEqual(definition, queue);
    assert.match(applyDraft(store, definition), new RegExp(`queue ${id} created as proposed`), t.id);
    assert.doesNotMatch(JSON.stringify(definition), /\{\{/, `${t.id}: nothing left unfilled`);
  }
  assert.equal(loadProjectState(store).queues.length, templates.length);
});

// Queue templates (templates.ts): the three layers, filling the placeholders, and Nexus's shipped templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** The maintenance templates (MT): each with the values of its required parameters. */
const MAINTENANCE: Record<string, Record<string, string>> = {
  dependencies: { outdated_command: "npm outdated", test_command: "npm test" },
  "security-audit": { audit_command: "npm audit" },
  "dead-code": { dead_code_command: "npx knip", lint_command: "npm run lint", test_command: "npm test" },
  "test-health": { test_command: "npm test" },
  performance: { perf_command: "npm run bench" },
  "docs-freshness": { docs: "README.md and docs/", code: "src/" },
  notes: { memory_dir: "~/.claude/projects/p/memory" },
};
/** The steps each of them has in survey mode and in fix_small mode. */
const MAINTENANCE_STEPS: Record<string, { survey: number; fix: number }> = {
  dependencies: { survey: 1, fix: 2 }, "security-audit": { survey: 1, fix: 1 }, "dead-code": { survey: 1, fix: 2 },
  "test-health": { survey: 3, fix: 3 }, performance: { survey: 1, fix: 1 }, "docs-freshness": { survey: 1, fix: 2 },
  notes: { survey: 3, fix: 4 },
};

/** Values for each shipped template's required parameters. */
const VALUES: Record<string, Record<string, string>> = {
  bugfix: { issue: "the list crashes when empty", area: "the dashboard" },
  "ui-change": { change: "a count beside each project", view: "project-rail" },
  spike: { question: "Can the CLI start faster?" },
  refactor: { target: "store.ts", reason: "smaller functions" },
  maintenance: {},
  "static-analysis": { test_command: "npm test" },
  ...MAINTENANCE,
};

test("Nexus's shipped templates, each filled, are valid queues the draft path accepts", () => {
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

test("a maintenance template: survey leaves out the steps for fix_small and the closing refactoring; fix_small keeps them", () => {
  const text = `template:
  id: care
  title: Care
maintenance: survey
coding: true
title: Care
steps:
  - id: "{{id}}1"
    title: Survey
    goal: Look.
  - id: "{{id}}2"
    maintenance: fix_small
    title: Fix
    goal: Fix the small things.
`;
  const t = parse(text);
  assert.equal(t.maintenance, "survey");
  const survey = fillTemplate(t, {}, "C");
  assert.deepEqual([(survey.steps as { id: string }[]).map((s) => s.id), survey.maintenance, survey.coding], [["C1"], "survey", false]);
  const fix = fillTemplate(t, {}, "C", { maintenance: "fix_small" });
  assert.deepEqual([(fix.steps as { id: string }[]).map((s) => s.id), fix.maintenance, fix.coding], [["C1", "C2"], "fix_small", true]);
  assert.equal(JSON.stringify(fix.steps).includes("maintenance"), false, "the steps' marks are gone");
  assert.throws(() => fillTemplate(parse(), { issue: "x" }, "F", { maintenance: "survey" }), /not a maintenance template/);
  assert.throws(() => parse(text.replace("maintenance: survey\n", "maintenance: always\n")), /survey or fix_small/);
  assert.throws(() => parse(text.replace("maintenance: survey\n", "")), /needs the template's maintenance/);
  assert.throws(() => parse(text.replace(/ {2}- id: "\{\{id\}\}1"\n {4}title: Survey\n {4}goal: Look.\n/, "")), /keeps at least one step/);
});

const shipped = () => readTemplates(undefined, { nexus: shippedTemplatesDir(), global: join(tmpdir(), "nexus-no-such-dir") }).templates;
const shippedTemplate = (id: string) => shipped().find((x) => x.id === id)!;
const stepIds = (q: Record<string, unknown>) => (q.steps as { id: string }[]).map((s) => s.id);

test("the maintenance templates: survey is coding: false without a fixing step; fix_small adds only the small fixes", () => {
  for (const id of Object.keys(MAINTENANCE)) {
    const t = shippedTemplate(id);
    assert.equal(t.maintenance, "survey", id);
    const survey = fillTemplate(t, MAINTENANCE[id]!, "M");
    assert.equal(survey.coding, false, id);
    assert.equal(survey.maintenance, "survey", id);
    assert.equal(stepIds(survey).length, MAINTENANCE_STEPS[id]!.survey, id);
    assert.equal(stepIds(fillTemplate(t, MAINTENANCE[id]!, "M", { maintenance: "fix_small" })).length, MAINTENANCE_STEPS[id]!.fix, id);
  }
  // The suite's health, the audit and the measurement never get a fixing step, not even in fix_small mode.
  for (const id of ["test-health", "security-audit", "performance"]) {
    const fix = fillTemplate(shippedTemplate(id), MAINTENANCE[id]!, "M", { maintenance: "fix_small" });
    assert.deepEqual(stepIds(fix), stepIds(fillTemplate(shippedTemplate(id), MAINTENANCE[id]!, "M")), id);
    assert.equal(fix.coding, false, id);
  }
  // The small fixes: patch updates, surely unused exports, typos in the documents.
  const fixStep = (id: string) => JSON.stringify((fillTemplate(shippedTemplate(id), MAINTENANCE[id]!, "M", { maintenance: "fix_small" }).steps as unknown[]).at(-1));
  assert.match(fixStep("dependencies"), /patch-level/);
  assert.match(fixStep("dead-code"), /surely unused/);
  assert.match(fixStep("docs-freshness"), /typos/);
  assert.match(fixStep("notes"), /typos/);
});

test("the test suite health template: three parts, candidates with their evidence and certainty, no coverage method", () => {
  const text = JSON.stringify(fillTemplate(shippedTemplate("test-health"), MAINTENANCE["test-health"]!, "M")).replaceAll("\\n", " ");
  for (const part of ["Flaky tests", "Slow tests", "Redundant tests"]) assert.match(text, new RegExp(part));
  assert.match(text, /places of the two tests/);
  assert.match(text, /the reasoning/);
  assert.match(text, /certain, likely or suspect/);
  assert.match(text, /parameterised test/);
  assert.match(text, /deleting or merging tests is proposed/);
  // Coverage appears only where it is ruled out as evidence.
  assert.match(text, /Do not use the coverage of the code as evidence/);
  assert.equal(text.match(/coverage/g)!.length, 1);
});

test("every maintenance template's report ends with the recommended additions; clone_command may be empty or given", () => {
  for (const id of Object.keys(MAINTENANCE)) {
    const text = JSON.stringify(fillTemplate(shippedTemplate(id), MAINTENANCE[id]!, "M"));
    assert.match(text, /ends with \\"Recommended additions\\" \(not counted among the findings\)/, id);
  }
  const t = shippedTemplate("test-health");
  assert.equal(t.params.find((p) => p.name === "clone_command")!.default, "");
  const store = ProjectStore.init(mkdtempSync(join(tmpdir(), "nexus-clone-")), { id: "p", name: "P", root: "." });
  const empty = fillTemplate(t, MAINTENANCE["test-health"]!, "CL1");
  const given = fillTemplate(t, { ...MAINTENANCE["test-health"]!, clone_command: "npx jscpd test/" }, "CL2");
  assert.match(applyDraft(store, empty), /created as proposed/);
  assert.match(applyDraft(store, given), /created as proposed/);
  assert.match(JSON.stringify(given), /npx jscpd test\//);
});

test("the shipped templates carry no command of the Nexus repository; its own instances in nexus-templates/ are valid", () => {
  for (const t of shipped()) assert.doesNotMatch(readFileSync(t.path, "utf8"), /npm run (knip|typecheck|test:files)|scripts\/capture|@nexus\/web|npx knip --/, t.id);
  const read = readTemplateDir(join(shippedTemplatesDir(), "..", "nexus-templates"), "project");
  assert.deepEqual(read.filter((x) => "problem" in x), []);
  const instances = read as Template[];
  assert.deepEqual(instances.map((t) => t.id).sort(), Object.keys(MAINTENANCE).map((x) => `nexus-${x}`).sort());
  for (const t of instances) {
    assert.ok(t.params.every((p) => p.default !== undefined), `${t.id}: every parameter has the repository's value`);
    assert.doesNotMatch(JSON.stringify(fillTemplate(t, {}, "NX")), /\{\{/, t.id);
  }
});

test("the notes template: needs memory_dir; survey only reads, the fix step touches the project documents alone", () => {
  const t = shippedTemplate("notes");
  assert.throws(() => fillTemplate(t, {}, "N"), /needs memory_dir/);
  const survey = fillTemplate(t, MAINTENANCE.notes!, "N");
  assert.equal(survey.coding, false);
  assert.deepEqual(stepIds(survey), ["N1", "N2", "N3"]);
  const text = JSON.stringify(survey).replaceAll("\\n", " ");
  for (const part of ["Memory notes", "Ideas notes", "Project documents"]) assert.match(text, new RegExp(part));
  assert.match(text, /`nexus template show docs-freshness`/);
  const fix = fillTemplate(t, MAINTENANCE.notes!, "N", { maintenance: "fix_small" });
  assert.deepEqual(stepIds(fix), ["N1", "N2", "N3", "N4"]);
  const step = (fix.steps as { goal: string }[]).at(-1)!.goal.replaceAll("\n", " ");
  assert.match(step, /Fix only the typos among the findings of N3 in AGENTS\.md and the design and protocol documents under docs\//);
  assert.match(step, /Touch no other file: not the code, not the memory notes in ~\/\.claude\/projects\/p\/memory, not the ideas notes in docs\/ideas/);
  // Reading outside the project: the parameter says which permission modes allow it, and a refused read is a finding.
  assert.match(t.params.find((p) => p.name === "memory_dir")!.description, /reads it in the auto permission mode, but not in dontAsk.*Read\(/);
  assert.match(text, /Reading the memory folder is refused by the permissions/);
  // The survey steps are told to change nothing.
  for (const st of (survey.steps as { goal: string }[])) assert.match(st.goal, /Change nothing, commit nothing/);
});

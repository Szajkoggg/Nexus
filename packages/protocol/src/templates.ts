// Queue templates (PROTOCOL.md, "Queue templates"): a queue's YAML with a `template:` header and `params:`, its texts
// carrying {{name}} placeholders. Three layers, strongest last: shipped with Nexus, the user's global ones, the
// project's. Parsing, merging the layers and filling are pure; reading the three folders is the last section.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { QueueFile } from "./schemas.ts";
import { nexusHome } from "./store.ts";

/** The layers, weakest first: a template of a later layer replaces one of an earlier layer with the same id. */
const TEMPLATE_LAYERS = ["nexus", "global", "project"] as const;
export type TemplateLayer = (typeof TEMPLATE_LAYERS)[number];

const NAME = /^[a-z][a-z0-9_]*$/;
/** A placeholder: {{name}}, spaces inside the braces allowed. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
/** The parameter every template has without declaring it: the queue's id (step ids are written `{{id}}1`). */
const ID_PARAM = "id";

const TemplateParam = z.object({
  name: z.string().regex(NAME, "a parameter's name is lowercase letters, digits and underscores, starting with a letter"),
  description: z.string().min(1),
  /** Without a default the parameter must be given. */
  default: z.string().optional(),
});
type TemplateParam = z.infer<typeof TemplateParam>;

const TemplateHeader = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a template id is 1-40 lowercase letters, digits and dashes"),
  title: z.string().min(1),
  description: z.string().optional(),
});

/** A template as read from its file: the header, the parameters and the queue skeleton (everything else). */
export interface Template {
  id: string;
  title: string;
  description?: string;
  params: TemplateParam[];
  /** The queue's fields as written, placeholders unfilled (no `id`: the queue's id is given when it is filled). */
  queue: Record<string, unknown>;
  layer: TemplateLayer;
  /** The file it was read from. */
  path: string;
}

export class TemplateError extends Error {}

/** Every placeholder name used in the string values of a tree (keys are not filled). */
function placeholders(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === "string") for (const m of x.matchAll(PLACEHOLDER)) out.add(m[1]!);
  else if (Array.isArray(x)) for (const v of x) placeholders(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) placeholders(v, out);
  return out;
}

/**
 * A template from its file's text. Refused (TemplateError, saying why): not YAML, no valid `template:` header, a
 * malformed or repeated parameter, one named `id` (it is the queue's), or a placeholder that names no parameter (it
 * would stay unfilled).
 */
export function parseTemplate(text: string, layer: TemplateLayer, path: string): Template {
  let doc: unknown;
  try { doc = YAML.parse(text); } catch (e) { throw new TemplateError(`not valid YAML: ${(e as Error).message}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new TemplateError("a template is a YAML mapping");
  const { template, params, id: _id, ...queue } = doc as Record<string, unknown>;
  const header = TemplateHeader.safeParse(template);
  if (!header.success) throw new TemplateError(`template: ${header.error.issues.map((i) => `${i.path.join(".") || "header"}: ${i.message}`).join("; ")}`);
  const list = z.array(TemplateParam).safeParse(params ?? []);
  if (!list.success) throw new TemplateError(`params: ${list.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const names = list.data.map((p) => p.name);
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);
  if (repeated.length) throw new TemplateError(`params: ${[...new Set(repeated)].join(", ")} declared more than once`);
  if (names.includes(ID_PARAM)) throw new TemplateError(`params: {{${ID_PARAM}}} is the queue's id, given when the template is filled: not a parameter of its own`);
  const unknown = [...placeholders(queue)].filter((n) => n !== ID_PARAM && !names.includes(n));
  if (unknown.length) throw new TemplateError(`placeholders that name no parameter, so they would stay unfilled: ${unknown.map((n) => `{{${n}}}`).join(", ")}`);
  if (!Array.isArray(queue.steps) || !queue.steps.length) throw new TemplateError("a template has at least one step");
  return { ...header.data, params: list.data, queue, layer, path };
}

/** A template that is not used: its file could not be read as one, or a stronger layer has the same id. */
export interface TemplateProblem { layer: TemplateLayer; path: string; problem: string }

/** The templates in effect: each id once, from its strongest layer, with the layers it replaces. */
export interface MergedTemplates {
  templates: (Template & { replaces: TemplateLayer[] })[];
  problems: TemplateProblem[];
}

/**
 * Merges the layers: for each id the template of the strongest layer (project over global over Nexus's). Two files of
 * one layer with the same id: the first by path is used and the other is a problem. Sorted by id.
 */
export function mergeTemplates(read: readonly (Template | TemplateProblem)[]): MergedTemplates {
  const problems: TemplateProblem[] = read.filter((x): x is TemplateProblem => "problem" in x);
  const byId = new Map<string, Template & { replaces: TemplateLayer[] }>();
  const rank = (l: TemplateLayer) => TEMPLATE_LAYERS.indexOf(l);
  const templates = read.filter((x): x is Template => !("problem" in x))
    .sort((a, b) => rank(a.layer) - rank(b.layer) || a.path.localeCompare(b.path));
  for (const t of templates) {
    const before = byId.get(t.id);
    if (before && before.layer === t.layer) {
      problems.push({ layer: t.layer, path: t.path, problem: `template id ${t.id} is also in ${before.path}, which is used` });
      continue;
    }
    byId.set(t.id, { ...t, replaces: before ? [...before.replaces, before.layer] : [] });
  }
  return { templates: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), problems };
}

/** The values for a template's parameters: those given, then the defaults. Refused: an unknown or missing one. */
function templateValues(t: Template, given: Readonly<Record<string, string>>, queueId: string): Record<string, string> {
  const unknown = Object.keys(given).filter((n) => !t.params.some((p) => p.name === n));
  if (unknown.length) throw new TemplateError(`template ${t.id} has no parameter ${unknown.join(", ")}${t.params.length ? ` (its parameters: ${t.params.map((p) => p.name).join(", ")})` : " (it has none)"}${unknown.includes(ID_PARAM) ? `; the queue's id is given with --id` : ""}`);
  const missing = t.params.filter((p) => given[p.name] === undefined && p.default === undefined);
  if (missing.length) throw new TemplateError(`template ${t.id} needs ${missing.map((p) => `${p.name} (${p.description})`).join("; ")}: give ${missing.length === 1 ? "it" : "them"} with --set name=value`);
  const values: Record<string, string> = { [ID_PARAM]: queueId };
  for (const p of t.params) values[p.name] = given[p.name] ?? p.default!;
  return values;
}

/** Replaces the placeholders in every string value; a value goes in as it is (a {{...}} inside it is not filled). */
function fill(x: unknown, values: Readonly<Record<string, string>>): unknown {
  if (typeof x === "string") return x.replace(PLACEHOLDER, (all, name: string) => values[name] ?? all);
  if (Array.isArray(x)) return x.map((v) => fill(v, values));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v, values)]));
  return x;
}

/**
 * The queue a template gives with these values: its fields with every placeholder filled, the id first. Refused
 * (TemplateError): an unknown or missing parameter, a placeholder left unfilled, or a result that is not a valid queue
 * definition. What the draft path checks besides (tags against the project's lists, an existing queue) it checks when
 * the draft is uploaded.
 */
export function fillTemplate(t: Template, given: Readonly<Record<string, string>>, queueId: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9][\w.-]{0,31}$/.test(queueId)) throw new TemplateError("a queue id is 1-32 letters, digits, dots, dashes or underscores");
  const values = templateValues(t, given, queueId);
  // parseTemplate refuses a placeholder without a parameter; this holds for a template made any other way too.
  const left = [...placeholders(t.queue)].filter((n) => values[n] === undefined);
  if (left.length) throw new TemplateError(`placeholders left unfilled: ${left.map((n) => `{{${n}}}`).join(", ")}`);
  const queue = { id: queueId, ...(fill(t.queue, values) as Record<string, unknown>) };
  const parsed = QueueFile.safeParse({ protocol: 1, ...queue });
  if (!parsed.success) throw new TemplateError(`the filled template is not a valid queue: ${parsed.error.issues.map((i) => `${i.path.join(".") || "queue"}: ${i.message}`).join("; ")}`);
  return queue;
}

/** A free queue id for a template: its id's letters and digits in capitals (at most 12), with a number when taken. */
export function templateQueueId(t: Pick<Template, "id">, taken: (id: string) => boolean): string {
  const base = t.id.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 12) || "Q";
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}${n}`)) return `${base}${n}`;
}

/** The YAML of a filled template, as `nexus queue draft --template` writes it into .nexus/drafts/. */
export function filledTemplateYaml(t: Template, queue: Record<string, unknown>, draftPath: string): string {
  const doc = new YAML.Document(queue);
  doc.commentBefore = [
    ` From template ${t.id} (${t.layer}: ${t.path}).`,
    " Complete what the template leaves general (the goals' details, the project's checks, tags such as the area:",
    " nexus tags; the texts in the queue's language), then upload it:",
    ` nexus queue draft ${draftPath}`,
  ].join("\n");
  return doc.toString({ lineWidth: 120 });
}

// ---------------------------------------------------------------- the three folders

/** Nexus's own templates, in its repository's templates/ (beside packages/); NEXUS_SHIPPED_TEMPLATES replaces it in tests. */
export function shippedTemplatesDir(): string {
  return process.env.NEXUS_SHIPPED_TEMPLATES ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates");
}
/** The user's templates for every project: <NEXUS_HOME>/templates/. */
const globalTemplatesDir = (): string => join(nexusHome(), "templates");
/** A project's templates, versioned in its repository: <root>/nexus-templates/ (not under .nexus/, which git ignores). */
const projectTemplatesDir = (root: string): string => join(root, "nexus-templates");

/** The templates of one folder (its *.yaml and *.yml files); a file that is not a template is a problem. */
export function readTemplateDir(dir: string, layer: TemplateLayer): (Template | TemplateProblem)[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort().map((f) => {
    const path = join(dir, f);
    try { return parseTemplate(readFileSync(path, "utf8"), layer, path); } catch (e) {
      return { layer, path, problem: (e as Error).message };
    }
  });
}

/** The templates in effect for a project (its root), or without one only Nexus's and the user's. */
export function readTemplates(projectRoot?: string, dirs = { nexus: shippedTemplatesDir(), global: globalTemplatesDir() }): MergedTemplates {
  return mergeTemplates([
    ...readTemplateDir(dirs.nexus, "nexus"),
    ...readTemplateDir(dirs.global, "global"),
    ...(projectRoot ? readTemplateDir(projectTemplatesDir(projectRoot), "project") : []),
  ]);
}

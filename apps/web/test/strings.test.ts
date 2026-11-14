// No user-facing text is written into the dashboard's components: JSX text and the text props (title, aria-label,
// placeholder, alt, and the label, hint and button props of our own components) come from the catalogue
// (src/messages/en.ts) through t() or rich(), apart from the exceptions below.
// The check reads the .tsx files with TypeScript's parser; a literal it finds is reported with its file and line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dirname, "..", "src");

/** The props whose text a user reads (or a screen reader says). */
const PROPS = new Set(["title", "aria-label", "placeholder", "alt", "label", "hint", "button", "empty", "defaultLabel", "of"]);

/** Text that stays as it is in every language, with why; allowed anywhere in a literal. */
const EXCEPTIONS: Record<string, string> = {
  Nexus: "the product's name",
  "Claude Code": "a product's name (the runtime choice)",
  Codex: "a product's name (the runtime choice)",
  "/login": "the sign-in page's path, after the address (Remote access)",
  "/../…worktrees": "an example path, the default worktrees folder beside the project (Settings)",
};

/** Elements whose text is code (a command, a file name): it stays as written in every language. */
const CODE = new Set(["code", "kbd"]);

/** Calls whose string arguments are catalogue keys, not texts. */
const KEY_CALLS = new Set(["t", "rich"]);

const words = (s: string) => /[A-Za-z]{2,}/.test(s);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []);
}

/** The literal texts in an expression that would be shown as they are: not keys of t()/rich(), not inside other calls' non-text arguments. */
function literalsIn(expr: ts.Node, out: ts.Node[]): void {
  const visit = (n: ts.Node): void => {
    // JSX inside is checked where it stands; a function's body is code (its JSX is checked as well).
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
    if (ts.isCallExpression(n)) {
      // t() and rich(): the key is not text, the parameters may be. Other calls' arguments are values (a join's
      // separator, a lookup), not shown as they are.
      if (ts.isIdentifier(n.expression) && KEY_CALLS.has(n.expression.text)) n.arguments.slice(1).forEach(visit);
      return;
    }
    if (ts.isObjectLiteralExpression(n)) { n.properties.forEach((p) => { if (ts.isPropertyAssignment(p)) visit(p.initializer); }); return; }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { out.push(n); return; }
    if (ts.isTemplateExpression(n)) {
      out.push(n.head);
      for (const s of n.templateSpans) { visit(s.expression); out.push(s.literal); }
      return;
    }
    // A comparison's operands are values, not text: `x === "done" ? … : …`.
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind)) return;
    if (ts.isConditionalExpression(n)) { visit(n.whenTrue); visit(n.whenFalse); return; }
    if (ts.isElementAccessExpression(n) || ts.isPropertyAccessExpression(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(expr);
}

const textOf = (n: ts.Node): string =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text
    : ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text
    : ts.isJsxText(n) ? n.text : "";

export function findLiterals(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (n: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    // What is left once the exceptions (product names) are taken out.
    const rest = Object.keys(EXCEPTIONS).reduce((x, e) => x.replaceAll(e, ""), t);
    if (!words(rest)) return;
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    found.push(`${relative(SRC, file).replaceAll("\\", "/")}:${line + 1}: ${JSON.stringify(t)}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) { if (!(ts.isJsxElement(n.parent) && CODE.has(n.parent.openingElement.tagName.getText(sf)))) report(n, n.text); }
    else if (ts.isJsxExpression(n) && n.expression && ts.isJsxElement(n.parent) || (ts.isJsxExpression(n) && n.expression && ts.isJsxFragment(n.parent))) {
      // {"text"} or {cond ? "a" : "b"} as a child.
      const lits: ts.Node[] = [];
      literalsIn(n.expression!, lits);
      for (const l of lits) report(l, textOf(l));
    } else if (ts.isJsxAttribute(n) && PROPS.has(n.name.getText(sf)) && n.initializer) {
      const lits: ts.Node[] = [];
      if (ts.isStringLiteral(n.initializer)) lits.push(n.initializer);
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) literalsIn(n.initializer.expression, lits);
      for (const l of lits) report(l, textOf(l));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test("the check finds JSX text and text props, and lets keys and exceptions through", () => {
  const sample = [
    `const a = <p title="Hello there">Some words</p>;`,
    `const b = <p title={t("x.y")} aria-label={ok ? "Yes it is" : t("no")}>{t("z")}</p>;`,
    `const c = <span>{n} · Nexus</span>;`,
    `const d = <i placeholder={\`A note for \${step}\`}>{" · "}</i>;`,
    `const e = <b>{x === "done" ? t("a") : t("b")}</b>;`,
    `const g = <code>nexus project add</code>;`,
  ].join("\n");
  const found = findLiterals(join(SRC, "sample.tsx"), sample).map((x) => x.replace(/^[^:]*:\d+: /, ""));
  assert.deepEqual(found, ['"Hello there"', '"Some words"', '"Yes it is"', '"A note for"']);
  assert.deepEqual(findLiterals(join(SRC, "sample.tsx"), `const f = <p>Nexus</p>;`), []);
});

test("no user-facing string literal is left in the components", () => {
  const found = tsxFiles(SRC).flatMap((f) => findLiterals(f, readFileSync(f, "utf8")));
  assert.deepEqual(found, [], `texts to move to src/messages/en.ts (or list as an exception):\n${found.join("\n")}`);
});

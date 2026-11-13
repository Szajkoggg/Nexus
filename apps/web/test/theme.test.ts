import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHOICES, DEFAULT_CHOICE, THEME_COLOR, THEME_KEY, THEMES, parseChoice, resolveTheme } from "../src/theme.ts";

test("the stored choice is read back; nothing stored or anything unknown is Graphite", () => {
  for (const c of ["graphite", "paper", "honey", "system"]) assert.equal(parseChoice(c), c);
  assert.equal(DEFAULT_CHOICE, "graphite");
  for (const raw of [null, undefined, "", "Paper", "dark", "zinc", '"paper"']) assert.equal(parseChoice(raw), "graphite");
});

test("following the system shows Paper when it is light and Graphite when it is dark", () => {
  assert.equal(resolveTheme("system", false), "paper");
  assert.equal(resolveTheme("system", true), "graphite");
});

test("a theme chosen by name shows whatever the system is", () => {
  for (const t of THEMES) {
    assert.equal(resolveTheme(t, true), t);
    assert.equal(resolveTheme(t, false), t);
  }
});

test("the settings offer every theme and following the system", () => {
  assert.deepEqual(CHOICES.map((c) => c.value).sort(), ["graphite", "honey", "paper", "system"]);
});

test("index.html's inline script, which runs before the first paint, keeps the same key, rules and colours", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes(`localStorage.getItem("${THEME_KEY}")`));
  assert.ok(html.includes('c === "system"') && html.includes('? "graphite" : "paper"'));
  for (const t of THEMES) assert.ok(html.includes(`${t}: "${THEME_COLOR[t]}"`), t);
});

test("every theme sets the same tokens, and the browser bar's colour is its page colour", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const tokens = (block: string) => [...block.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const);
  const graphite = tokens(css.slice(css.indexOf("@theme {"), css.indexOf("--font-sans")));
  const names = graphite.map(([n]) => n).filter((n) => n !== "*").sort();
  for (const t of ["paper", "honey"] as const) {
    const start = css.indexOf(`html[data-theme="${t}"]`);
    const block = tokens(css.slice(start, css.indexOf("}", start)));
    assert.deepEqual(block.map(([n]) => n).sort(), names, t);
    assert.equal(block.find(([n]) => n === "canvas")![1], THEME_COLOR[t]);
  }
  assert.equal(graphite.find(([n]) => n === "canvas")![1], THEME_COLOR.graphite);
});

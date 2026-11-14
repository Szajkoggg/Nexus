// The language settings (PROTOCOL.md, "Languages"): the reader's language, global with a project override, and the
// working language, a project's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError, GlobalSettings, LANGUAGES, OVERRIDABLE, ProjectFile, ProjectStore, StoredProject, builtInSettings, effectiveProject, languageName, ownKeys,
  readGlobalSettings, settingKey, updateGlobalSettings, updateSettings,
} from "../src/index.ts";

function project() {
  const base = mkdtempSync(join(tmpdir(), "nexus-languages-"));
  process.env.NEXUS_HOME = join(base, "home");
  const store = ProjectStore.init(join(base, "p"), { id: "p", name: "P", root: join(base, "p") });
  return { store, stored: () => store.readStoredProject() };
}

test("the offered languages are the user's list, in its order", () => {
  assert.deepEqual(LANGUAGES.map((l) => l.name), ["Hungarian", "English", "Danish", "German", "Spanish", "French", "Polish", "Italian"]);
  assert.equal(languageName("hu"), "Hungarian");
});

test("defaults: the reader's language is none (the language the user writes in), the working language English", () => {
  assert.equal(builtInSettings().languages.reader, undefined);
  const p = ProjectFile.parse({ protocol: 1, id: "p", name: "P", root: "C:/p" });
  assert.equal(p.languages.reader, undefined);
  assert.equal(p.languages.working, "en");
  const { store, stored } = project();
  assert.deepEqual([store.readProject().languages.reader, store.readProject().languages.working], [undefined, "en"]);
  assert.equal(stored().languages.reader, undefined, "a new project follows the global reader's language");
  assert.ok(OVERRIDABLE.some((x) => settingKey(x.path) === "languages.reader" && x.none), "global with an override; none has a meaning");
  assert.ok(!OVERRIDABLE.some((x) => settingKey(x.path) === "languages.working"), "the working language is the project's only");
});

test("the reader's language: the global value, a project's own, and a project's own 'none' over a global one", () => {
  const g = GlobalSettings.parse({ protocol: 1, languages: { reader: "hu" } });
  const base = { protocol: 1, id: "p", name: "P", root: "C:/p", follows_global: true };
  const at = (languages?: object) => StoredProject.parse({ ...base, languages });
  assert.equal(effectiveProject(at(), g).languages.reader, "hu", "follows the global value");
  assert.equal(effectiveProject(at({ reader: "de" }), g).languages.reader, "de", "its own");
  assert.equal(effectiveProject(at({ reader: null }), g).languages.reader, undefined, "its own: the language the user writes in");
  assert.equal(effectiveProject(at({ working: "da" }), g).languages.working, "da");
});

test("changing the languages: the global reader's language reaches following projects; own, follow and the working language", () => {
  const { store, stored } = project();
  updateGlobalSettings({ languages: { reader: "hu" } });
  assert.equal(readGlobalSettings().languages.reader, "hu");
  assert.equal(store.readProject().languages.reader, "hu", "a following project has it at once");

  updateSettings(store, { languages: { reader: "fr", working: "de" } });
  assert.deepEqual(stored().languages, { reader: "fr", working: "de" });
  assert.deepEqual(ownKeys(stored()), ["languages.reader"]);
  updateGlobalSettings({ languages: { reader: "pl" } });
  assert.equal(store.readProject().languages.reader, "fr", "its own value stays");

  // Its own "the language the user writes in", while the global value names one.
  updateSettings(store, { languages: { reader: null }, own: ["languages.reader"] });
  assert.equal(stored().languages.reader, null);
  assert.equal(store.readProject().languages.reader, undefined);

  updateSettings(store, { follow: ["languages.reader"] });
  assert.equal(stored().languages.reader, undefined);
  assert.equal(store.readProject().languages.reader, "pl");
  assert.equal(store.readProject().languages.working, "de", "the working language is untouched by following");

  // Clearing the global value: back to the language the user writes in.
  updateGlobalSettings({ languages: { reader: null } });
  assert.equal(readGlobalSettings().languages.reader, undefined);
  assert.equal(store.readProject().languages.reader, undefined);

  assert.throws(() => updateSettings(store, { languages: { working: "xx" } }), (e: Error) => e instanceof ActionError && /languages\.working/.test(e.message));
  assert.throws(() => updateGlobalSettings({ languages: { reader: "klingon" } }), (e: Error) => e instanceof ActionError && /languages\.reader/.test(e.message));
  assert.throws(() => updateSettings(store, { follow: ["languages.working"] }), (e: Error) => e instanceof ActionError && /not a setting with a global value/.test(e.message));
});

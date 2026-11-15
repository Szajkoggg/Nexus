import { test } from "node:test";
import assert from "node:assert/strict";
import { Dictation, recognitionOf, voiceError, voiceLanguage, withHeard, type DictationState, type Recognition, type RecognitionErrorEvent, type RecognitionResultEvent } from "../src/voice.ts";

/** A recognition that hears what the test says: no microphone, no service. */
class FakeRecognition implements Recognition {
  static last: FakeRecognition | undefined;
  lang = "";
  continuous = true;
  interimResults = false;
  onresult: ((e: RecognitionResultEvent) => void) | null = null;
  onerror: ((e: RecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor() { FakeRecognition.last = this; }
  start() { this.started++; }
  stop() { this.stopped++; this.onend?.(); }
  abort() { this.aborted++; }
  hear(parts: { text: string; final: boolean }[], from = 0) {
    this.onresult?.({ resultIndex: from, results: parts.map((p) => ({ isFinal: p.final, 0: { transcript: p.text } })) });
  }
}

function dictation() {
  const heard: string[] = [];
  const states: DictationState[] = [];
  const d = new Dictation(FakeRecognition, { heard: (t) => heard.push(t), state: (s) => states.push(s) });
  return { d, heard, states };
}

test("the microphone is offered only where the browser recognises speech", () => {
  assert.equal(recognitionOf({}), undefined, "Firefox: no SpeechRecognition");
  assert.equal(recognitionOf({ SpeechRecognition: FakeRecognition }), FakeRecognition);
  assert.equal(recognitionOf({ webkitSpeechRecognition: FakeRecognition }), FakeRecognition, "Chrome's prefixed name");
  assert.equal(recognitionOf({ SpeechRecognition: "not a class" }), undefined);
});

test("the language comes from the reader's language, in the region the browser uses for it", () => {
  assert.equal(voiceLanguage("hu", ["en-GB", "en"]), "hu-HU");
  assert.equal(voiceLanguage("hu", ["hu-HU", "en-US"]), "hu-HU");
  assert.equal(voiceLanguage("en", ["da-DK", "en-GB"]), "en-GB", "the browser's own English");
  assert.equal(voiceLanguage("en", ["en"]), "en-US", "a browser that names no region");
  assert.equal(voiceLanguage("de", []), "de-DE");
});

test("without a reader's language, the browser's language", () => {
  assert.equal(voiceLanguage(undefined, ["da-DK", "en-US"]), "da-DK");
  assert.equal(voiceLanguage(undefined, []), undefined, "nothing known: the recognition takes the page's");
});

test("what is heard goes after the text in the box, with a space between", () => {
  assert.equal(withHeard("", "hello"), "hello");
  assert.equal(withHeard("Look at", "the second step"), "Look at the second step");
  assert.equal(withHeard("First line\n", " second "), "First line\nsecond");
  assert.equal(withHeard("kept", "   "), "kept", "nothing heard leaves the text as it was");
});

test("a dictation listens in the language given, hands over final text only, and never sends", () => {
  const { d, heard, states } = dictation();
  d.start("hu-HU");
  const r = FakeRecognition.last!;
  assert.equal(r.started, 1);
  assert.equal(r.lang, "hu-HU");
  assert.equal(r.continuous, false, "one utterance: a silence ends it");
  assert.equal(r.interimResults, true);
  assert.equal(d.listening, true);
  r.hear([{ text: "nézzük meg", final: false }]);
  assert.deepEqual(heard, [], "what is still being heard is not put into the box");
  assert.deepEqual(states.at(-1), { listening: true, interim: "nézzük meg" });
  r.hear([{ text: "nézzük meg a második lépést", final: true }]);
  assert.deepEqual(heard, ["nézzük meg a második lépést"]);
  r.onend!();
  assert.equal(d.listening, false);
  assert.deepEqual(states.at(-1), { listening: false, interim: "", error: undefined });
  // The Dictation has no way to send: its only way out is `heard`, which the box appends to its draft (useDraftText).
  assert.deepEqual(Object.getOwnPropertyNames(Dictation.prototype).sort(), ["constructor", "dispose", "listening", "start", "stop"]);
});

test("pressing again stops it; a second start while listening starts nothing", () => {
  const { d } = dictation();
  d.start(undefined);
  const r = FakeRecognition.last!;
  assert.equal(r.lang, "", "no language known: the recognition's own default");
  d.start("en-GB");
  assert.equal(FakeRecognition.last, r);
  d.stop();
  assert.equal(r.stopped, 1);
  assert.equal(d.listening, false);
});

test("an error says why it ended; the user's own stop says nothing", () => {
  const { d, states } = dictation();
  d.start("hu-HU");
  FakeRecognition.last!.onerror!({ error: "not-allowed" });
  FakeRecognition.last!.onend!();
  assert.equal(states.at(-1)!.error, "voice.notAllowed");
  assert.equal(voiceError("aborted"), undefined);
  assert.equal(voiceError("no-speech"), "voice.noSpeech");
  assert.equal(voiceError("something new"), "voice.failed");
});

test("disposing aborts without handing anything over", () => {
  const { d, heard, states } = dictation();
  d.start("hu-HU");
  const r = FakeRecognition.last!;
  const before = states.length;
  d.dispose();
  assert.equal(r.aborted, 1);
  assert.equal(r.onresult, null);
  assert.deepEqual(heard, []);
  assert.equal(states.length, before);
});

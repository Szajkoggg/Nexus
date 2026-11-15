// Speaking into a chat's box (queue BI): the browser's speech recognition (the Web Speech API), where it has one.
// Chrome, Edge and Safari have it (Chrome and Edge send the sound to their maker's servers to recognise it); Firefox has
// none, and there the microphone button is not shown. What is heard goes into the box after what is there, and is
// never sent by itself. One utterance at a time: the recognition stops at a silence, or when the button is pressed
// again.
//
// Pure apart from the recognition class it is given, so it is unit tested (test/voice.test.ts) with a fake one;
// useDictation (components/Voice.tsx) is the React side.
import type { Key } from "./i18n.ts";

/** One result of a recognition: its best alternative, and whether it is final or still being heard. */
interface RecognitionResult { readonly isFinal: boolean; readonly 0: { readonly transcript: string } }
export interface RecognitionResultEvent { readonly resultIndex: number; readonly results: ArrayLike<RecognitionResult> }
export interface RecognitionErrorEvent { readonly error: string }

/** The part of the browser's SpeechRecognition the dashboard uses. */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionClass = new () => Recognition;

/** The browser's speech recognition (standard or Chrome's prefixed name), or undefined where it has none (Firefox). */
export function recognitionOf(w: object): RecognitionClass | undefined {
  const x = w as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const c = x.SpeechRecognition ?? x.webkitSpeechRecognition;
  return typeof c === "function" ? c as RecognitionClass : undefined;
}

/** The region each offered reader's language is recognised in when the browser names none of its own (languages.ts). */
const REGION: Record<string, string> = { hu: "HU", en: "US", da: "DK", de: "DE", es: "ES", fr: "FR", pl: "PL", it: "IT" };

/**
 * The language to recognise, as a BCP-47 tag: the reader's language (Nexus's settings), in the region the browser
 * uses for it when it has one ("en" with a British browser: "en-GB"), else its usual one ("hu": "hu-HU"). Without a
 * reader's language, the browser's own; undefined when that is not known either (the recognition then takes the
 * page's).
 */
export function voiceLanguage(reader: string | undefined, browser: readonly string[]): string | undefined {
  if (!reader) return browser.find(Boolean);
  const own = browser.find((b) => b.toLowerCase().split("-")[0] === reader.toLowerCase() && b.includes("-"));
  if (own) return own;
  const region = REGION[reader.toLowerCase()];
  return region ? `${reader.toLowerCase()}-${region}` : reader;
}

/** The box's text with what was heard after it: on the same line, a space between them; nothing heard, as it was. */
export function withHeard(text: string, heard: string): string {
  const h = heard.trim();
  if (!h) return text;
  if (!text || /\s$/.test(text)) return text + h;
  return `${text} ${h}`;
}

/** Why a recognition ended without text, for the line under the box; nothing for a stop the user asked for. */
export function voiceError(code: string): Key | undefined {
  switch (code) {
    case "aborted": return undefined;
    case "no-speech": return "voice.noSpeech";
    case "not-allowed": case "service-not-allowed": return "voice.notAllowed";
    case "audio-capture": return "voice.noMicrophone";
    case "network": return "voice.network";
    case "language-not-supported": return "voice.language";
    default: return "voice.failed";
  }
}

/** Where a dictation is: listening (with what it has heard so far that is not final yet), or not, and why it ended. */
export interface DictationState { listening: boolean; interim: string; error?: Key }

/**
 * One box's dictation: start() listens for one utterance, stop() ends it early (what was heard by then still comes).
 * Each final piece of text goes to `heard`, which puts it into the box; nothing is ever sent.
 */
export class Dictation {
  private current: Recognition | undefined;
  private readonly make: RecognitionClass;
  private readonly on: { heard: (text: string) => void; state: (s: DictationState) => void };

  constructor(make: RecognitionClass, on: { heard: (text: string) => void; state: (s: DictationState) => void }) {
    this.make = make;
    this.on = on;
  }

  get listening(): boolean { return !!this.current; }

  start(lang: string | undefined): void {
    if (this.current) return;
    const r = new this.make();
    if (lang) r.lang = lang;
    r.continuous = false;
    r.interimResults = true;
    let error: Key | undefined;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) this.on.heard(res[0].transcript);
        else interim += res[0].transcript;
      }
      this.on.state({ listening: true, interim: interim.trim() });
    };
    r.onerror = (e) => { error = voiceError(e.error); };
    r.onend = () => {
      if (this.current !== r) return;
      this.current = undefined;
      this.on.state({ listening: false, interim: "", error });
    };
    this.current = r;
    this.on.state({ listening: true, interim: "" });
    try {
      r.start();
    } catch {
      this.current = undefined;
      this.on.state({ listening: false, interim: "", error: "voice.failed" });
    }
  }

  stop(): void { this.current?.stop(); }

  /** Ends it without waiting for what is still being recognised: the box is going away. */
  dispose(): void {
    const r = this.current;
    this.current = undefined;
    if (r) { r.onresult = r.onerror = r.onend = null; r.abort(); }
  }
}

// The microphone in a chat's box (voice.ts): shown only where the browser recognises speech, in the reader's language.
// What is heard goes into the box after its text; it is sent only when the user sends it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Dictation, recognitionOf, voiceLanguage, type DictationState } from "../voice.ts";
import { usePage } from "../page.ts";
import { t } from "../i18n.ts";

/** Set once the line about where the sound goes has been shown (at the first use, in this browser). */
const NOTICE_KEY = "nexus.voice.noticed";

export interface Voice { state: DictationState; notice: boolean; toggle: () => void }

/**
 * A box's dictation, or undefined where the browser has no speech recognition (Firefox): then no microphone is shown.
 * `append` puts what was heard into the box.
 */
export function useVoice(append: (heard: string) => void): Voice | undefined {
  const make = useMemo(() => (typeof window === "undefined" ? undefined : recognitionOf(window)), []);
  const { reader } = usePage();
  const [state, setState] = useState<DictationState>({ listening: false, interim: "" });
  const [notice, setNotice] = useState(false);
  const heard = useRef(append);
  useEffect(() => { heard.current = append; }, [append]);
  const dictation = useMemo(() => make && new Dictation(make, { heard: (text) => heard.current(text), state: setState }), [make]);
  useEffect(() => () => dictation?.dispose(), [dictation]);
  if (!dictation) return undefined;
  const toggle = () => {
    if (dictation.listening) { dictation.stop(); return; }
    if (!noticed()) { setNotice(true); markNoticed(); }
    dictation.start(voiceLanguage(reader, navigator.languages?.length ? navigator.languages : [navigator.language]));
  };
  return { state, notice, toggle };
}

function noticed(): boolean { try { return localStorage.getItem(NOTICE_KEY) === "1"; } catch { return false; } }
function markNoticed(): void { try { localStorage.setItem(NOTICE_KEY, "1"); } catch { /* storage blocked: said again next time */ } }

/** The microphone: round beside the phone's box, square in the desktop's card; a stop square while it listens. */
export function MicButton({ voice, round }: { voice: Voice; round?: boolean }) {
  const on = voice.state.listening;
  const label = t(on ? "voice.stop" : "voice.start");
  const shape = round ? "h-11 w-11 rounded-full border" : "mb-1 h-9 w-9 rounded-lg";
  const look = on
    ? "border-danger bg-danger/15 text-danger"
    : `text-fg-2 hover:text-fg ${round ? "border-line-strong bg-canvas" : "hover:bg-surface-3"}`;
  return (
    <button type="button" onClick={voice.toggle} aria-label={label} title={label} aria-pressed={on}
      className={`relative grid shrink-0 place-items-center ${shape} ${look}`}>
      {on && <span className={`absolute inset-0 animate-ping ${round ? "rounded-full" : "rounded-lg"} bg-danger/20`} />}
      {on
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" />
          </svg>
        )}
    </button>
  );
}

/** The line under the box: listening (and what is being heard), why it ended without text, and at the first use, where the sound goes. */
export function VoiceLine({ voice }: { voice: Voice | undefined }) {
  if (!voice) return null;
  const { listening, interim, error } = voice.state;
  if (!listening && !error && !voice.notice) return null;
  return (
    <div className="mt-1.5 space-y-0.5 px-1 text-xs" aria-live="polite">
      {listening && (
        <p className="text-fg-2">
          <span className="mr-1 text-danger">●</span>{t("voice.listening")}{" "}
          {interim ? <span className="italic text-fg">{interim}</span> : <span className="text-fg-3">{t("voice.stopHint")}</span>}
        </p>
      )}
      {!listening && error && <p className="text-danger">{t(error)}</p>}
      {voice.notice && <p className="text-fg-3">{t("voice.notice")}</p>}
    </div>
  );
}

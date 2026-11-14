// The file viewer's highlighter, loaded only when a code file is opened (a chunk of its own). Highlight.js grammars
// through lowlight: lowlight returns a syntax tree, not an HTML string, so the viewer renders the code as React text
// (escaped by React) and never injects HTML. Chosen over Shiki (TextMate grammars and themes, several times the size,
// fixed colour themes) and Prism or plain highlight.js (HTML strings). Its classes take the theme's colours (index.css).
import { common, createLowlight } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import vbscript from "highlight.js/lib/languages/vbscript";
import { linesOf, plainLines, type Hast, type Token } from "./fileview.ts";

const low = createLowlight(common);
low.register({ dockerfile, powershell, vbscript });

/** The text as lines of highlighted tokens; plain lines for a language the highlighter does not know. */
export function highlight(text: string, language: string): Token[][] {
  if (!low.registered(language)) return plainLines(text);
  return linesOf(low.highlight(language, text) as unknown as Hast);
}

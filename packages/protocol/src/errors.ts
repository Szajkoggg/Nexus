// The text of a thrown value, one way for the whole codebase (the lint forbids `(e as Error).message`).

/** An Error's message; anything else thrown (a string, undefined, an object) as `String(e)`, so the text is never `undefined`. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

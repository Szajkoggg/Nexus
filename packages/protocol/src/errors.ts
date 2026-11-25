// The text of a thrown value, one way for the whole codebase (the lint forbids `(e as Error).message`).

/** An Error's message; anything else thrown (a string, undefined, an object) as `String(e)`, so the text is never `undefined`. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A schema's complaint about one value (a zod issue): where in the value, and what is wrong. */
interface Issue { readonly path: readonly PropertyKey[]; readonly message: string }

/**
 * A schema error's text, one way everywhere: each issue as `path: message`, joined by "; ", the path written as
 * `root` when the issue is about the whole value. Anything without issues (a YAML syntax error, a system error) is
 * its errorText.
 */
export function formatIssues(e: unknown, root = ""): string {
  const issues = (e as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return errorText(e);
  return (issues as Issue[]).map((i) => `${i.path.map(String).join(".") || root}: ${i.message}`).join("; ");
}

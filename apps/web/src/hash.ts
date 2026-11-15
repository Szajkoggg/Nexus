// The dashboard's addresses, built and read in one place (unit tested in test/hash.test.ts). What is selected lives in
// the URL hash: #/<project>[/<queue>[/<step>]], each part encoded. A link meant for a new tab adds what opens over the
// project's page in the query: ?file=<path>[&line=<n>] (the file viewer) or ?commit=<hash> (a commit's details).

/** The hash of a project's page, or of a queue or step in its drawer. */
export function itemHash(project: string, queue?: string, step?: string): string {
  return "#/" + [project, queue, step].filter((x): x is string => !!x).map(encodeURIComponent).join("/");
}

/** A part as it was before encoding; one typed by hand that is no valid encoding, as it is. */
const decoded = (part: string) => { try { return decodeURIComponent(part); } catch { return part; } };

/** What a hash selects (decoded); a hash with nothing selects no project. */
export function parseHash(hash: string): { project?: string; queue?: string; step?: string } {
  const [project, queue, step] = hash.replace(/^#\/?/, "").split("/").map(decoded).filter(Boolean);
  return { project, queue, step };
}

/** A queue or step is selected: the drawer is open. */
export const hasItem = (hash: string): boolean => !!parseHash(hash).queue;

/** The hash of the project's page a hash is on, without its queue or step (as it is written). */
export const projectPart = (hash: string): string => hash.replace(/^(#\/[^/]+).*$/, "$1");

/** A link that opens a file of the project in the viewer, at a line. */
export const fileHref = (project: string, path: string, line?: number): string =>
  `?file=${encodeURIComponent(path)}${line ? `&line=${line}` : ""}${itemHash(project)}`;

/** A link that opens a commit's details over the project's page. */
export const commitHref = (project: string, hash: string): string => `?commit=${hash}${itemHash(project)}`;

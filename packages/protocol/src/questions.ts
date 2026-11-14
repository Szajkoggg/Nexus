// A question's recommended answer: one of its options, named by the asker (`nexus ask --recommend`) or by the
// orchestrator passing the question on (`nexus answer --escalate --recommend`). The CLI checks it here before it
// writes the event; the state derivation keeps only a recommendation that is one of the options.

/**
 * The option a recommendation names: its exact text, or its number (1 is the first). Throws, saying what is wrong,
 * when the question has no options or the recommendation names none of them.
 */
export function recommendedOption(options: readonly string[] | undefined, given: string): string {
  if (!options?.length) throw new Error("a recommendation names one of the question's options, and this question has none (give them with --option)");
  if (options.includes(given)) return given;
  const n = /^\d+$/.test(given.trim()) ? Number(given.trim()) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
  const listed = options.map((o, i) => `${i + 1}. ${o}`).join("; ");
  throw new Error(`the recommendation "${given}" is not one of the options (${listed}); name one by its text or its number`);
}

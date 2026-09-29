/** Whitespace between two quoted words, optionally followed by one Markdown table delimiter row
 * (`|---|---|`), which ingestion adds under a table's first row: it is formatting, so a faithful
 * quote omits it. Each part can match in only one way, so a non-matching quote fails in linear
 * time instead of backtracking. */
const GAP = String.raw`\s+(?:\|?:?-{2,}[-:| \t]*\n\s*)?`;

/**
 * Finds a model-quoted passage in its source and returns the source's own text for it.
 *
 * Models reproduce wording faithfully but not layout: they collapse table padding, turn a space
 * into a line break, and skip table delimiter rows. A quote therefore matches when its words appear
 * in order separated only by such layout, and the source's verbatim text is returned so stored
 * citations stay exact. Any difference in the words themselves is still a mismatch.
 */
export function findVerbatimQuote(source: string, quote: string): string | null {
  if (quote.trim().length < 8) return null;
  if (source.includes(quote)) return quote;
  const pattern = new RegExp(quote.trim().split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(GAP));
  return source.match(pattern)?.[0] ?? null;
}

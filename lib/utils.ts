export { cn } from "cn";

const TITLE_CASE_MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to"]);

/** Formats a machine value (e.g. `needs_information`) or phrase as a Title Case UI label. */
export function titleCase(value: string): string {
  return value.replaceAll("_", " ").split(" ").map((word, index) => {
    const lower = word.toLowerCase();
    if (index > 0 && TITLE_CASE_MINOR_WORDS.has(lower)) return lower;
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  }).join(" ");
}

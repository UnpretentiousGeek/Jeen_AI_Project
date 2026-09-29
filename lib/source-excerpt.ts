const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LABELLED_LINE = /^([A-Z][^:\n]{0,39}):\s+(\S.*)$/;

const JSON_OPEN = /^(?:"([^"]+)":\s*)?[[{]$/;
const JSON_CLOSE = /^[}\]],?$/;
const JSON_FIELD = /^"([^"]+)":\s*(.+?),?$/;
const JSON_ITEM = /^("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*),?$/;
// Response envelope and linkage keys, not facts about the record.
const JSON_SKIPPED_TREES = new Set(["meta", "links", "relationships"]);
const JSON_SKIPPED_KEYS = new Set(["type", "kind", "etag", "language"]);
// Keys that only mean something under their parent (`legalName.name`, `registeredAt.id`).
const JSON_GENERIC_KEYS = new Set(["name", "value", "id"]);
// Wrappers around the record; a generic key directly under one (`data.id`) is not a fact.
const JSON_ENVELOPES = new Set(["", "data", "attributes"]);

function jsonLabel(key: string): string {
  if (key.length <= 3) return key.toUpperCase();
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function jsonScalar(raw: string): string | null {
  if (!raw || raw === "null" || raw === "[]" || raw === "{}") return null;
  if (!raw.startsWith('"')) return raw;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Reads a pretty-printed JSON response, possibly cut off at the excerpt limit, as labelled facts.
 * Address parts gather under the address they belong to; generic keys take their parent's name.
 */
function jsonFacts(text: string): Array<[string, string]> {
  const facts = new Map<string, string[]>();
  const path: string[] = [];
  const add = (key: string, value: string) => {
    if (path.some((segment) => JSON_SKIPPED_TREES.has(segment)) || JSON_SKIPPED_KEYS.has(key)) return;
    const address = [...path].reverse().find((segment) => /address$/i.test(segment));
    const named = JSON_GENERIC_KEYS.has(key) ? [...path].reverse().find((segment) => segment !== "") : key;
    const segment = address ?? named;
    if (!segment || (!address && JSON_ENVELOPES.has(segment))) return;
    const label = jsonLabel(segment);
    const values = facts.get(label) ?? [];
    if (!values.includes(value)) values.push(value);
    facts.set(label, values);
  };
  for (const line of text.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const open = JSON_OPEN.exec(line);
    if (open) {
      path.push(open[1] ?? "");
      continue;
    }
    if (JSON_CLOSE.test(line)) {
      path.pop();
      continue;
    }
    const field = JSON_FIELD.exec(line);
    if (field) {
      const [, key = "", raw = ""] = field;
      const value = jsonScalar(raw);
      if (value) add(key, value);
      continue;
    }
    const [, raw = ""] = JSON_ITEM.exec(line) ?? [];
    const value = jsonScalar(raw);
    const parent = path.at(-1);
    if (value && parent !== undefined) add(parent, value);
  }
  return [...facts].map(([label, values]) => [label, values.join(", ")]);
}

/**
 * The labelled facts an excerpt states, or null when it is ordinary text. A registry record is
 * stored as one `Label: value` per line; results stored before that keep the registry's raw JSON.
 */
export function sourceFacts(text: string): Array<[string, string]> | null {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed) && /"[^"]+":/.test(trimmed)) {
    const facts = jsonFacts(trimmed);
    return facts.length > 0 ? facts : null;
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const facts: Array<[string, string]> = [];
  for (const line of lines) {
    const [, label, value] = LABELLED_LINE.exec(line) ?? [];
    if (!label || !value) return null;
    facts.push([label, value]);
  }
  return facts;
}

/**
 * Reads a quoted fragment of stored source text as plain text. Ingestion keeps tables as
 * Markdown rows, and a fragment of one cannot render as a table, so table rows become
 * `cell · cell`, one row per line, and delimiter rows are dropped. Labelled facts read the same way.
 */
export function formatSourceExcerpt(text: string): string {
  const facts = sourceFacts(text);
  if (facts) return facts.map(([label, value]) => `${label} · ${value}`).join("\n");
  return text
    .split("\n")
    .filter((line) => !TABLE_DELIMITER_ROW.test(line))
    .map((line) => line.includes("|")
      ? line.split("|").map((cell) => cell.trim()).filter(Boolean).join(" · ")
      : line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Whether a web result was read from a registry's API rather than fetched as a page. Results
 * stored before the retrieval method recorded this are recognised by their raw JSON excerpt.
 */
export function isRegistryRead(retrievalMethod: string | null | undefined, excerpt: string): boolean {
  return retrievalMethod === "registry_api" || /^\s*\{\s*"/.test(excerpt);
}

const CHUNK_ONLY_LOCATOR = /^(?:(page \d+) · )?(?:document )?chunk \d+$/i;

/**
 * A citation locator a reviewer can use. Document chunk numbers are ingestion internals, so a
 * chunk-only locator is dropped and a page-plus-chunk locator keeps just its page.
 */
export function readableLocator(locator: string | null | undefined): string {
  const trimmed = locator?.trim() ?? "";
  const chunk = CHUNK_ONLY_LOCATOR.exec(trimmed);
  if (!chunk) return trimmed;
  const page = chunk[1];
  return page ? page.charAt(0).toUpperCase() + page.slice(1) : "";
}

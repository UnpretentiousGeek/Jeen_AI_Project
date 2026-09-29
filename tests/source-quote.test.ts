import { describe, expect, it } from "vitest";

import { findVerbatimQuote } from "../src/source-quote.ts";

const table = [
  "Entity record",
  "| Legal name                  | Morgan Stanley |",
  "|-----------------------------|----------------|",
  "| Registration number         | 923632         |",
].join("\n");

describe("findVerbatimQuote", () => {
  it("returns an exact quote unchanged", () => {
    expect(findVerbatimQuote(table, "| Registration number         | 923632         |"))
      .toBe("| Registration number         | 923632         |");
  });

  it("returns the source's text when the quote differs only in layout", () => {
    expect(findVerbatimQuote("obtain and verify its name. Regulation 28(3)(b)", "its name.\n\nRegulation 28(3)(b)"))
      .toBe("its name. Regulation 28(3)(b)");
    // Table padding collapsed and the delimiter row under the first row skipped.
    expect(findVerbatimQuote(table, "| Legal name | Morgan Stanley |\n| Registration number | 923632 |"))
      .toBe(table.slice(table.indexOf("| Legal name")));
  });

  it("rejects different words and quotes too short to be evidence", () => {
    expect(findVerbatimQuote(table, "| Legal name | Morgan Stanley & Co. LLC |")).toBeNull();
    expect(findVerbatimQuote(table, "923632")).toBeNull();
  });

  it("fails fast on a long quote that does not match", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| Field ${i}      | Value ${i}      |`);
    const source = [rows[0], "|-----------|-----------|", ...rows.slice(1)].join("\n");
    const quote = `${rows.slice(0, 150).join("\n")}\n| Field missing | Value |`;
    const started = performance.now();
    expect(findVerbatimQuote(source, quote)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

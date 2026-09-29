import { describe, expect, it } from "vitest";

import { formatSourceExcerpt, readableLocator, sourceFacts } from "../lib/source-excerpt.ts";

describe("formatSourceExcerpt", () => {
  it("reads a stored table row fragment as cells", () => {
    expect(formatSourceExcerpt("SEC file number                    | 1-11758")).toBe("SEC file number · 1-11758");
  });

  it("drops delimiter rows and keeps one line per row", () => {
    const excerpt = "| Legal name   | Morgan Stanley |\n|--------------|:--------------:|\n| Jurisdiction | Delaware |";
    expect(formatSourceExcerpt(excerpt)).toBe("Legal name · Morgan Stanley\nJurisdiction · Delaware");
  });

  it("leaves prose unchanged apart from surrounding whitespace", () => {
    expect(formatSourceExcerpt("  The applicant does not claim to hold a licence.  ")).toBe(
      "The applicant does not claim to hold a licence.",
    );
  });
});

// A GLEIF record as stored before registry records were excerpted: pretty-printed and cut off.
const LEGACY_GLEIF_EXCERPT = `{
  "meta": {
    "goldenCopy": {
      "publishDate": "2026-09-27T16:00:00Z"
    }
  },
  "data": {
    "type": "lei-records",
    "id": "IGJSJL3JD5P30I6NJZ34",
    "attributes": {
      "lei": "IGJSJL3JD5P30I6NJZ34",
      "entity": {
        "legalName": {
          "name": "MORGAN STANLEY",
          "language": "en"
        },
        "otherNames": [],
        "legalAddress": {
          "language": "en",
          "addressLines": [
            "C/O THE CORPORATION TRUST COMPANY",
            "1209 ORANGE ST"
          ],
          "addressNumber": null,
          "city": "WILMINGTON",
          "region": "US-DE",
          "country": "US",
          "postalCode": "19801"
        },
        "registeredAt": {
          "id": "RA000602",
          "other": null
        },
        "registeredAs": "0923632",
        "jurisdiction": "US-DE",
        "status": "ACT`;

describe("sourceFacts", () => {
  it("reads a registry's raw JSON response as the facts it states", () => {
    expect(sourceFacts(LEGACY_GLEIF_EXCERPT)).toEqual([
      ["LEI", "IGJSJL3JD5P30I6NJZ34"],
      ["Legal name", "MORGAN STANLEY"],
      ["Legal address", "C/O THE CORPORATION TRUST COMPANY, 1209 ORANGE ST, WILMINGTON, US-DE, US, 19801"],
      ["Registered at", "RA000602"],
      ["Registered as", "0923632"],
      ["Jurisdiction", "US-DE"],
    ]);
  });

  it("reads a labelled registry excerpt line by line", () => {
    expect(sourceFacts("Legal name: MORGAN STANLEY\nJurisdiction: US-DE")).toEqual([
      ["Legal name", "MORGAN STANLEY"],
      ["Jurisdiction", "US-DE"],
    ]);
  });

  it("leaves prose and single labelled sentences alone", () => {
    expect(sourceFacts("Note: the applicant is regulated.")).toBeNull();
    expect(sourceFacts("The register lists\nNote: two directors.")).toBeNull();
  });

  it("formats facts like document table rows", () => {
    expect(formatSourceExcerpt("Legal name: MORGAN STANLEY\nJurisdiction: US-DE")).toBe(
      "Legal name · MORGAN STANLEY\nJurisdiction · US-DE",
    );
  });
});

describe("readableLocator", () => {
  it("drops document chunk numbers and keeps pages and sections", () => {
    expect(readableLocator("Document chunk 2")).toBe("");
    expect(readableLocator("page 3 · chunk 7")).toBe("Page 3");
    expect(readableLocator("KYB-1.1")).toBe("KYB-1.1");
    expect(readableLocator(null)).toBe("");
  });
});

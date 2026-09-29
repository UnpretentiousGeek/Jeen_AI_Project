import { describe, expect, it } from "vitest";

import { BUSINESS_TYPES, JURISDICTIONS, PRODUCTS, caseOptionLabel } from "../src/case-catalog.js";
import { createCaseSchema } from "../src/api/contracts.js";

const caseInput = {
  legal_name: "Example Ltd",
  jurisdiction: "GB",
  business_type: "marketplace",
  product: "cross_border_payouts",
};

describe("case context codes", () => {
  it("accepts policy matching codes and keeps readable labels", () => {
    expect(createCaseSchema.safeParse(caseInput).success).toBe(true);
    expect(createCaseSchema.safeParse({ ...caseInput, jurisdiction: "US-CA" }).success).toBe(true);
    expect(caseOptionLabel(JURISDICTIONS, "GB")).toBe("United Kingdom");
    expect(caseOptionLabel(JURISDICTIONS, "US-CA")).toBe("United States — California");
    expect(caseOptionLabel(BUSINESS_TYPES, "marketplace")).toBe("Marketplace");
    expect(caseOptionLabel(PRODUCTS, "cross_border_payouts")).toBe("Cross-Border Payouts");
  });

  it("rejects display labels that would silently miss policy matching", () => {
    expect(createCaseSchema.safeParse({ ...caseInput, jurisdiction: "United Kingdom" }).success).toBe(false);
    expect(createCaseSchema.safeParse({ ...caseInput, business_type: "Marketplace" }).success).toBe(false);
    expect(createCaseSchema.safeParse({ ...caseInput, product: "Cross-Border Payouts" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { parseAddressClarification } from "../src/workflow/address-clarification.js";

describe("address clarification", () => {
  it("extracts a narrowly structured current registered address", () => {
    expect(parseAddressClarification(
      "The current registered address is 41 Threadneedle Street, London.",
    )).toEqual({ address: "41 Threadneedle Street, London" });
  });

  it("rejects an unstructured answer", () => {
    expect(() => parseAddressClarification("Use the incorporation document."))
      .toThrow("State the address");
  });
});

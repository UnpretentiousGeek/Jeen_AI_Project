import { describe, expect, it } from "vitest";

import { parseOwnershipClarification } from "../src/workflow/ownership-clarification.js";

describe("ownership clarification parsing", () => {
  it("extracts the exact missing owner and percentage", () => {
    expect(parseOwnershipClarification(
      "Northbridge Nominees Ltd holds the remaining 18%.",
      18,
    )).toEqual({
      ownerName: "Northbridge Nominees Ltd",
      percentage: 18,
    });
  });

  it("rejects ambiguous or incorrectly scoped statements", () => {
    expect(() => parseOwnershipClarification("It is Northbridge.", 18)).toThrow(
      "State the owner's name and percentage",
    );
    expect(() => parseOwnershipClarification("Northbridge owns 20%.", 18)).toThrow(
      "remaining 18%",
    );
  });
});

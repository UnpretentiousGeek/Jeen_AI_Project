import { describe, expect, it } from "vitest";

import { activityDeclarationSchema, evaluateRuleScope, providerProfileSchema } from "../src/policy/applicability.js";

const provider = providerProfileSchema.parse({
  legal_name: "Example Payments Ltd",
  regulated_roles: ["payment_institution"],
  service_jurisdictions: ["US-CA", "GB"],
});

const activity = activityDeclarationSchema.parse({
  operating_jurisdictions: ["US-CA"],
  payment_activity: "facilitates",
  handles_customer_funds: "no",
  licensing_basis: "partner",
});

const scope = {
  provider_roles: ["payment_institution"],
  provider_jurisdictions: ["US"],
  applicant_payment_activities: ["facilitates"],
  operating_jurisdictions: ["US-CA"],
  funds_handling: "no" as const,
};

describe("policy rule applicability", () => {
  it("uses the provider and business activity captured for a run", () => {
    expect(evaluateRuleScope(scope, { provider, activity }).status).toBe("applies");
    expect(evaluateRuleScope(scope, { provider: null, activity }).status).toBe("needs_information");
    expect(evaluateRuleScope(scope, { provider, activity: null }).status).toBe("needs_information");
  });

  it("excludes a known location or payment activity mismatch", () => {
    expect(evaluateRuleScope({ ...scope, operating_jurisdictions: ["US-NY"] }, { provider, activity }).status)
      .toBe("does_not_apply");
    expect(evaluateRuleScope({ ...scope, applicant_payment_activities: ["receives_or_transmits"] }, { provider, activity }).status)
      .toBe("does_not_apply");
  });

  it("does not mistake a country-only location for a known state", () => {
    const countryOnly = activityDeclarationSchema.parse({ ...activity, operating_jurisdictions: ["US"] });
    expect(evaluateRuleScope(scope, { provider, activity: countryOnly }).status).toBe("needs_information");
  });

  it("accepts operating countries without adding them as applicant jurisdictions", () => {
    expect(activityDeclarationSchema.parse({ ...activity, operating_jurisdictions: ["GB", "IE", "DE"] })
      .operating_jurisdictions).toEqual(["GB", "IE", "DE"]);
  });
});

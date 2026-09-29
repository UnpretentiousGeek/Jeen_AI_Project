import { z } from "zod";

import {
  JURISDICTIONS,
  LICENSING_BASIS_CODES,
  OPERATING_JURISDICTIONS,
  PAYMENT_ACTIVITY_CODES,
  YES_NO_UNKNOWN_CODES,
} from "../case-catalog.ts";

const jurisdiction = z.string().refine(
  (value) => JURISDICTIONS.some((option) => option.value === value),
  "Choose a supported jurisdiction.",
);
const operatingJurisdiction = z.string().refine(
  (value) => OPERATING_JURISDICTIONS.some((option) => option.value === value),
  "Choose a supported operating location.",
);

export const providerRoleSchema = z.enum([
  "bank", "payment_institution", "money_transmitter", "marketplace",
]);
export const paymentActivitySchema = z.enum(PAYMENT_ACTIVITY_CODES);
export const yesNoUnknownSchema = z.enum(YES_NO_UNKNOWN_CODES);
export const licensingBasisSchema = z.enum(LICENSING_BASIS_CODES);

export const providerProfileSchema = z.object({
  legal_name: z.string().trim().min(1).max(200),
  regulated_roles: z.array(providerRoleSchema).min(1).max(4),
  service_jurisdictions: z.array(jurisdiction).min(1).max(JURISDICTIONS.length),
}).strict().refine((value) => new Set(value.regulated_roles).size === value.regulated_roles.length
  && new Set(value.service_jurisdictions).size === value.service_jurisdictions.length,
"Choose each role and jurisdiction once.");

export const activityDeclarationSchema = z.object({
  operating_jurisdictions: z.array(operatingJurisdiction).max(OPERATING_JURISDICTIONS.length).default([]),
  payment_activity: paymentActivitySchema.default("unknown"),
  handles_customer_funds: yesNoUnknownSchema.default("unknown"),
  licensing_basis: licensingBasisSchema.default("unknown"),
}).strict().refine((value) => new Set(value.operating_jurisdictions).size === value.operating_jurisdictions.length,
"Choose each operating jurisdiction once.");

export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type ActivityDeclaration = z.infer<typeof activityDeclarationSchema>;
export type Applicability = "applies" | "does_not_apply" | "needs_information";

export type RuleScope = {
  provider_roles: string[];
  provider_jurisdictions: string[];
  applicant_payment_activities: string[];
  operating_jurisdictions: string[];
  funds_handling: "yes" | "no" | null;
};

export type ApplicabilityContext = {
  provider: ProviderProfile | null;
  activity: ActivityDeclaration | null;
};

function locationMatch(required: string[], actual: string[]): Applicability {
  if (required.length === 0) return "applies";
  if (actual.length === 0) return "needs_information";
  if (required.some((location) => actual.includes(location)
    || (location === "US" && actual.some((item) => item.startsWith("US-"))))) return "applies";
  if (actual.includes("US") && required.some((item) => item.startsWith("US-"))) return "needs_information";
  return "does_not_apply";
}

export function evaluateRuleScope(scope: RuleScope, context: ApplicabilityContext): {
  status: Applicability;
  reasons: string[];
} {
  const statuses: Array<{ status: Applicability; reason: string }> = [];
  if (scope.provider_roles.length) {
    const roles = context.provider?.regulated_roles ?? [];
    statuses.push({
      status: roles.length === 0 ? "needs_information"
        : scope.provider_roles.some((role) => roles.includes(role as ProviderProfile["regulated_roles"][number]))
          ? "applies" : "does_not_apply",
      reason: "provider regulated role",
    });
  }
  if (scope.provider_jurisdictions.length) {
    statuses.push({
      status: locationMatch(scope.provider_jurisdictions, context.provider?.service_jurisdictions ?? []),
      reason: "provider service jurisdiction",
    });
  }
  if (scope.applicant_payment_activities.length) {
    const activity = context.activity?.payment_activity ?? "unknown";
    statuses.push({
      status: activity === "unknown" ? "needs_information"
        : scope.applicant_payment_activities.includes(activity) ? "applies" : "does_not_apply",
      reason: "applicant payment activity",
    });
  }
  if (scope.operating_jurisdictions.length) {
    statuses.push({
      status: locationMatch(scope.operating_jurisdictions, context.activity?.operating_jurisdictions ?? []),
      reason: "applicant operating jurisdiction",
    });
  }
  if (scope.funds_handling) {
    const handling = context.activity?.handles_customer_funds ?? "unknown";
    statuses.push({
      status: handling === "unknown" ? "needs_information"
        : handling === scope.funds_handling ? "applies" : "does_not_apply",
      reason: "applicant handling of customer funds",
    });
  }
  const failed = statuses.filter((item) => item.status === "does_not_apply");
  if (failed.length) return { status: "does_not_apply", reasons: failed.map((item) => item.reason) };
  const unknown = statuses.filter((item) => item.status === "needs_information");
  if (unknown.length) return { status: "needs_information", reasons: unknown.map((item) => item.reason) };
  return { status: "applies", reasons: statuses.map((item) => item.reason) };
}

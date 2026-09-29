import { z } from "zod";

import { scopedCitationSchema, scopedTaskBaseSchema } from "./task-contract.js";

const selectorSchema = z.array(z.string().min(1)).min(1);

export const policyEvidenceSchema = scopedCitationSchema.extend({
  requirement_code: z.string().min(1),
  requirement: z.string().min(1),
  jurisdictions: selectorSchema,
  products: selectorSchema,
  business_types: selectorSchema,
});

export const policyTaskInputSchema = scopedTaskBaseSchema.extend({
  applicant: z.object({
    jurisdiction: z.string().min(1),
    product: z.string().min(1),
    business_type: z.string().min(1),
  }),
  case_evidence: z.array(scopedCitationSchema).min(1),
  policy_evidence: z.array(policyEvidenceSchema).min(1),
});

export type PolicyTaskInput = z.infer<typeof policyTaskInputSchema>;

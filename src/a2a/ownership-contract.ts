import { z } from "zod";

import {
  scopedCitationSchema,
  scopedHumanInputEvidenceSchema,
  scopedTaskBaseSchema,
} from "./task-contract.js";

export const ownershipTaskInputSchema = scopedTaskBaseSchema.extend({
  ownership_interests: z.array(z.object({
    owner_name: z.string().min(1),
    percentage: z.number().min(0).max(100),
  })).min(1),
  case_evidence: z.array(scopedCitationSchema).min(1),
  policy_evidence: z.array(scopedCitationSchema).min(1),
  human_input_evidence: z.array(scopedHumanInputEvidenceSchema).optional(),
});

export type OwnershipTaskInput = z.infer<typeof ownershipTaskInputSchema>;

import { z } from "zod";

import {
  scopedCitationSchema,
  scopedHumanInputEvidenceSchema,
  scopedTaskBaseSchema,
} from "./task-contract.js";

export const entityTaskInputSchema = scopedTaskBaseSchema.extend({
  declared_legal_name: z.string().min(1),
  registered_legal_name: z.string().min(1),
  declared_address: z.string().min(1),
  registered_address: z.string().min(1),
  case_evidence: z.array(scopedCitationSchema).min(1),
  policy_evidence: z.array(scopedCitationSchema).min(1),
  human_input_evidence: z.array(scopedHumanInputEvidenceSchema).optional(),
});

export type EntityTaskInput = z.infer<typeof entityTaskInputSchema>;

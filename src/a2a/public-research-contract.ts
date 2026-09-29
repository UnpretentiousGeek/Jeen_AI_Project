import { z } from "zod";

import { identifierSchema } from "../contracts/shared.js";
import { scopedTaskBaseSchema } from "./task-contract.js";

export const scopedExternalWebEvidenceSchema = z.object({
  id: identifierSchema,
  search_execution_id: identifierSchema,
  url: z.url(),
  canonical_url: z.url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  published_at: z.iso.datetime().nullable(),
  retrieved_at: z.iso.datetime(),
  excerpt: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const publicResearchTaskInputSchema = scopedTaskBaseSchema.extend({
  search_execution_id: identifierSchema,
  approved_query: z.string().min(1),
  approved_by: identifierSchema,
  content_treatment: z.literal("untrusted_public_evidence"),
  policy_authority: z.literal(false),
  web_evidence: z.array(scopedExternalWebEvidenceSchema),
}).superRefine((input, context) => {
  for (const [index, evidence] of input.web_evidence.entries()) {
    if (evidence.search_execution_id !== input.search_execution_id) {
      context.addIssue({
        code: "custom",
        message: "web evidence belongs to a different approved search execution",
        path: ["web_evidence", index, "search_execution_id"],
      });
    }
  }
});

export type PublicResearchTaskInput = z.infer<typeof publicResearchTaskInputSchema>;

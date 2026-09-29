import { z } from "zod";
import { BUSINESS_TYPES, JURISDICTIONS, PRODUCTS } from "../case-catalog.ts";
import { activityDeclarationSchema } from "../policy/applicability.ts";

const entityTextSchema = z.string().trim().min(1).max(500);
const jurisdictionSchema = z.string().trim().refine(
  (value) => JURISDICTIONS.some((option) => option.value === value) || /^US-[A-Z]{2}$/.test(value),
  "Choose a supported jurisdiction code.",
);
const businessTypeSchema = z.string().trim().refine(
  (value) => BUSINESS_TYPES.some((option) => option.value === value),
  "Choose a supported business type code.",
);
const productSchema = z.string().trim().refine(
  (value) => PRODUCTS.some((option) => option.value === value),
  "Choose a supported product code.",
);

export const entityDeclarationSchema = z.object({
  legal_name: z.string().trim().min(1).max(200).optional(),
  jurisdiction: jurisdictionSchema.optional(),
  identifiers: z.array(z.object({
    type: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(120),
    jurisdiction: z.string().trim().min(2).max(80),
  }).strict()).min(1).refine(
    (identifiers) => identifiers.some((identifier) => identifier.type === "registration_number"),
    "Include a registration number.",
  ),
  addresses: z.object({
    registered: entityTextSchema,
    operating: entityTextSchema,
    mailing: entityTextSchema,
  }).strict(),
}).strict();

export const createCaseSchema = z.object({
  legal_name: z.string().trim().min(1).max(200),
  jurisdiction: jurisdictionSchema,
  business_type: businessTypeSchema,
  product: productSchema,
  submitted_payload: z.object({
    entity_declaration: entityDeclarationSchema.optional(),
    activity_declaration: activityDeclarationSchema.optional(),
  }).catchall(z.unknown()).default({}),
}).superRefine((value, context) => {
  const declaration = value.submitted_payload.entity_declaration;
  if (declaration?.legal_name && declaration.legal_name !== value.legal_name) {
    context.addIssue({
      code: "custom",
      path: ["submitted_payload", "entity_declaration", "legal_name"],
      message: "Declared legal name must match the case legal name.",
    });
  }
  if (declaration?.jurisdiction && declaration.jurisdiction !== value.jurisdiction) {
    context.addIssue({
      code: "custom",
      path: ["submitted_payload", "entity_declaration", "jurisdiction"],
      message: "Declared jurisdiction must match the case jurisdiction.",
    });
  }
});

export const startAnalysisSchema = z.object({
  analyst_instructions: z.string().trim().max(2_000).nullable().optional(),
  task_objective: z.string().trim().min(1).max(2_000).default(
    "Perform a complete KYB analysis using the pinned case evidence and policies.",
  ),
});

export const checkpointResponseSchema = z.object({
  request_id: z.string().trim().min(1),
  action_id: z.string().trim().min(1),
  actor_id: z.string().trim().min(1).max(200),
  idempotency_key: z.string().trim().min(8).max(300),
  values: z.record(z.string(), z.unknown()).default({}),
});

export const finalDecisionSchema = z.object({
  analysis_run_id: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  actor_id: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(2_000),
  idempotency_key: z.string().trim().min(8).max(300),
});

export const archiveCaseSchema = z.object({
  archived: z.boolean(),
}).strict();

export const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "Invalid UUID",
);

export const openableSourceKindSchema = z.enum(["case_document", "policy", "external_web"]);
export type OpenableSourceKind = z.infer<typeof openableSourceKindSchema>;

export const activeRunStatuses = new Set(["queued", "running"]);

export function shouldPollRun(status: string, coordinatorPhase?: string | null): boolean {
  return activeRunStatuses.has(status) || coordinatorPhase === "running";
}

export type CreateCaseInput = z.infer<typeof createCaseSchema>;
export type EntityDeclaration = z.infer<typeof entityDeclarationSchema>;
export type StartAnalysisInput = z.infer<typeof startAnalysisSchema>;
export type CheckpointResponseInput = z.infer<typeof checkpointResponseSchema>;

export interface UploadedEvidence {
  document_type: string;
  original_filename: string;
  mime_type: string;
  checksum_sha256: string;
  storage_path: string;
}

export interface AnalysisRunRecord {
  id: string;
  case_id: string;
  session_id: string;
  status: string;
  analyst_instructions: string | null;
  created_at: string | Date;
}

export interface PendingCheckpoint {
  request_id: string;
  checkpoint_kind: string;
  expected_state_version: number;
  request_payload: Record<string, unknown>;
  skipped_at?: string | Date | null;
}

export interface LangflowInvocation {
  flow_id: string;
  job_id: string;
  status: string;
  session_id: string;
  purpose: "evidence_ingestion" | "analysis_start" | "analysis_resume";
}

import { z } from "zod";

export const identifierSchema = z.string().min(1);

export const rationaleSchema = z.object({
  requirement: z.string().min(1),
  evidence_assessment: z.string().min(1),
  uncertainty: z.string().min(1),
  conclusion: z.string().min(1),
  recommendation: z.string().min(1),
});

const caseDocumentCitationSchema = z.object({
  id: identifierSchema,
  source_kind: z.literal("case_document"),
  source_id: identifierSchema,
  chunk_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
});

const policyCitationSchema = z.object({
  id: identifierSchema,
  source_kind: z.literal("policy"),
  source_id: identifierSchema,
  chunk_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
});

export const humanInputCitationSchema = z.object({
  id: identifierSchema,
  source_kind: z.literal("human_input"),
  source_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  submitted_by: identifierSchema,
  submitted_at: z.iso.datetime(),
});

export const externalWebCitationSchema = z.object({
  id: identifierSchema,
  source_kind: z.literal("external_web"),
  url: z.url(),
  canonical_url: z.url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  published_at: z.iso.datetime().nullable(),
  retrieved_at: z.iso.datetime(),
  excerpt: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  retrieval_method: z.enum(["firecrawl_search", "tinyfish_search", "tinyfish_fetch", "registry_api"]),
  search_execution_id: identifierSchema,
  agent_task_id: identifierSchema,
  agent_artifact_id: identifierSchema,
});

export const citationSchema = z.discriminatedUnion("source_kind", [
  caseDocumentCitationSchema,
  policyCitationSchema,
  humanInputCitationSchema,
  externalWebCitationSchema,
]);

export type Citation = z.infer<typeof citationSchema>;

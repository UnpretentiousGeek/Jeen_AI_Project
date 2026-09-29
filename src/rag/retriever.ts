import { z } from "zod";

import { type Citation, citationSchema, identifierSchema } from "../contracts/shared.js";

const retrievedPassageSchema = z.object({
  source_kind: z.enum(["case_document", "policy"]),
  source_id: identifierSchema,
  chunk_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  retrieval_score: z.coerce.number(),
  retrieval_mode: z.enum(["lexical", "hybrid"]),
});

export type RetrievedPassage = z.infer<typeof retrievedPassageSchema>;

interface RetrievalQueryResult {
  rows: unknown[];
}

export interface RetrievalDatabase {
  query(text: string, values: unknown[]): Promise<RetrievalQueryResult>;
}

export interface RetrieveRunEvidenceRequest {
  analysisRunId: string;
  query: string;
  limit?: number;
  queryEmbedding?: number[];
}

export interface RetrievedRunEvidence {
  caseEvidence: RetrievedPassage[];
  policyEvidence: RetrievedPassage[];
}

function vectorLiteral(embedding: number[] | undefined): string | null {
  if (embedding === undefined) {
    return null;
  }
  if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("query embedding must contain finite numbers");
  }
  return `[${embedding.join(",")}]`;
}

export class PostgresRunEvidenceRetriever {
  constructor(private readonly database: RetrievalDatabase) {}

  async retrieve(request: RetrieveRunEvidenceRequest): Promise<RetrievedRunEvidence> {
    const query = request.query.trim();
    if (query === "") {
      throw new Error("retrieval query cannot be empty");
    }
    const limit = request.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("retrieval limit must be an integer between 1 and 20");
    }
    const values = [request.analysisRunId, query, vectorLiteral(request.queryEmbedding), limit];
    const [caseResult, policyResult] = await Promise.all([
      this.database.query(
        "SELECT * FROM retrieve_case_evidence($1::uuid, $2, $3::vector, $4)",
        values,
      ),
      this.database.query(
        "SELECT * FROM retrieve_policy_evidence($1::uuid, $2, $3::vector, $4)",
        values,
      ),
    ]);

    return {
      caseEvidence: z.array(retrievedPassageSchema).parse(caseResult.rows),
      policyEvidence: z.array(retrievedPassageSchema).parse(policyResult.rows),
    };
  }
}

export function passageToCitation(passage: RetrievedPassage): Citation {
  return citationSchema.parse({
    id: `rag-${passage.source_kind}-${passage.chunk_id}`,
    source_kind: passage.source_kind,
    source_id: passage.source_id,
    chunk_id: passage.chunk_id,
    locator: passage.locator,
    excerpt: passage.excerpt,
  });
}

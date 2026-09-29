import type { Pool, PoolClient } from "pg";

export type AssistantSource = {
  id: string;
  kind: "case" | "finding" | "evidence_gap" | "conflict" | "citation" | "case_document" | "policy" | "external_web";
  locator?: string;
  title?: string;
  url?: string;
};

export type AssistantTurn = {
  id: string;
  case_id: string;
  actor_id: string;
  question: string;
  answer: string | null;
  analysis_run_id: string | null;
  source_refs: AssistantSource[];
  status: "pending" | "completed" | "failed";
  claim_token: string;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

export type AssistantCaseContext = {
  case_id: string;
  reference: string;
  status: string;
  case_created_at: string | Date;
  case_updated_at: string | Date;
  status_changed_at: string | Date | null;
  legal_name: string;
  jurisdiction: string;
  business_type: string;
  product: string;
  entity_declaration: Record<string, unknown> | null;
  analysis_run_id: string | null;
  analysis_run_status: string | null;
  analysis_run_started_at: string | Date | null;
  analysis_run_finished_at: string | Date | null;
  pending_checkpoint_kind: string | null;
  final_decision: Record<string, unknown> | null;
};

export type AssistantReview = {
  findings: Record<string, unknown>[];
  evidence_gaps: Record<string, unknown>[];
  conflicts: Record<string, unknown>[];
  citations: Record<string, unknown>[];
};

export type AssistantEmbeddingChunk = {
  id: string;
  kind: "document" | "policy";
  content: string;
};

// Must exceed ASSISTANT_ANSWER_DEADLINE_MS plus one in-flight tool round (Cohere calls time
// out after 30s each) so only abandoned turns are reclaimed.
const STALE_PENDING_TURN_INTERVAL = "10 minutes";

// Matches chunks containing every query term first, then chunks containing any term.
const queryTermsCte = `query_terms AS (
         SELECT websearch_to_tsquery('english', $2) AS all_terms,
                replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery AS any_term
       )`;

export interface AssistantRepository {
  getCaseContext(caseId: string): Promise<AssistantCaseContext | null>;
  listTurns(caseId: string, limit: number, before?: string): Promise<AssistantTurn[]>;
  claimTurn(input: {
    caseId: string;
    actorId: string;
    question: string;
    idempotencyKey: string;
  }): Promise<{ state: "claimed" | "completed" | "busy" | "in_progress"; turn?: AssistantTurn }>;
  completeTurn(input: {
    turnId: string;
    claimToken: string;
    answer: string;
    analysisRunId: string | null;
    sourceRefs: AssistantSource[];
  }): Promise<AssistantTurn | null>;
  failTurn(turnId: string, claimToken: string): Promise<void>;
  getReview(runId: string): Promise<AssistantReview>;
  searchCaseEvidence(runId: string, query: string, queryEmbedding?: number[]): Promise<Record<string, unknown>[]>;
  searchPolicyEvidence(runId: string, query: string, queryEmbedding?: number[]): Promise<Record<string, unknown>[]>;
  searchAcceptedWebEvidence(runId: string, query: string): Promise<Record<string, unknown>[]>;
  listUnembeddedChunks(runId: string, limit: number): Promise<AssistantEmbeddingChunk[]>;
  storeEmbeddings(rows: { id: string; kind: AssistantEmbeddingChunk["kind"]; embedding: number[] }[]): Promise<void>;
}

const turnColumns = `id::text, case_id::text, actor_id, question, answer,
  analysis_run_id::text, source_refs, status, claim_token::text,
  created_at, updated_at, completed_at`;

export class PostgresAssistantRepository implements AssistantRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCaseContext(caseId: string): Promise<AssistantCaseContext | null> {
    const result = await this.pool.query<AssistantCaseContext>(
      `SELECT c.id::text AS case_id, c.reference, c.status,
              c.created_at AS case_created_at, c.updated_at AS case_updated_at,
              status_change.created_at AS status_changed_at,
              a.legal_name, a.jurisdiction, a.business_type, a.product,
              app.submitted_payload->'entity_declaration' AS entity_declaration,
              run.id::text AS analysis_run_id, run.status AS analysis_run_status,
              run.started_at AS analysis_run_started_at,
              run.finished_at AS analysis_run_finished_at,
              pending_checkpoint.checkpoint_kind AS pending_checkpoint_kind,
              CASE WHEN decision.id IS NULL THEN NULL ELSE jsonb_build_object(
                'decision', decision.decision, 'rationale', decision.rationale,
                'actor', decision.actor, 'decided_at', decision.decided_at,
                'analysis_run_id', decision.analysis_run_id
              ) END AS final_decision
       FROM onboarding_cases c
       JOIN applicants a ON a.id = c.applicant_id
       JOIN applications app ON app.id = c.application_id
       LEFT JOIN analysis_runs run
         ON run.id = c.active_analysis_run_id AND run.case_id = c.id
       LEFT JOIN LATERAL (
         SELECT event.created_at
         FROM audit_events event
         WHERE event.case_id = c.id
           AND event.event_type = 'case.status_changed'
           AND event.payload->>'to' = c.status
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
       ) status_change ON true
       LEFT JOIN LATERAL (
         SELECT checkpoint.checkpoint_kind
         FROM coordinator_v3_checkpoints checkpoint
         WHERE checkpoint.analysis_run_id = run.id
           AND checkpoint.case_id = c.id
           AND checkpoint.status = 'pending'
         ORDER BY checkpoint.created_at DESC, checkpoint.id DESC
         LIMIT 1
       ) pending_checkpoint ON true
       LEFT JOIN case_final_decisions decision ON decision.case_id = c.id
       WHERE c.id = $1::uuid`,
      [caseId],
    );
    return result.rows[0] ?? null;
  }

  async listTurns(caseId: string, limit: number, before?: string): Promise<AssistantTurn[]> {
    const result = await this.pool.query<AssistantTurn>(
      `SELECT ${turnColumns} FROM (
         SELECT * FROM case_assistant_turns WHERE case_id = $1::uuid
           AND ($3::uuid IS NULL OR (created_at, id) < (
             SELECT created_at, id FROM case_assistant_turns
             WHERE case_id = $1::uuid AND id = $3::uuid
           ))
         ORDER BY created_at DESC, id DESC LIMIT $2
       ) recent ORDER BY created_at, id`,
      [caseId, limit, before ?? null],
    );
    return result.rows;
  }

  async claimTurn(input: {
    caseId: string;
    actorId: string;
    question: string;
    idempotencyKey: string;
  }): Promise<{ state: "claimed" | "completed" | "busy" | "in_progress"; turn?: AssistantTurn }> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO case_assistant_conversations (case_id) VALUES ($1::uuid)
         ON CONFLICT (case_id) DO NOTHING`,
        [input.caseId],
      );
      await client.query(
        `SELECT case_id FROM case_assistant_conversations WHERE case_id = $1::uuid FOR UPDATE`,
        [input.caseId],
      );
      const existing = await client.query<AssistantTurn>(
        `SELECT ${turnColumns} FROM case_assistant_turns
         WHERE case_id = $1::uuid AND idempotency_key = $2`,
        [input.caseId, input.idempotencyKey],
      );
      const turn = existing.rows[0];
      if (turn && (turn.actor_id !== input.actorId || turn.question !== input.question)) {
        throw new Error("assistant_idempotency_conflict");
      }
      if (turn?.status === "completed") return { state: "completed", turn };

      const pending = await client.query<{ id: string; stale: boolean }>(
        `SELECT id::text, updated_at < now() - $2::interval AS stale
         FROM case_assistant_turns WHERE case_id = $1::uuid AND status = 'pending'`,
        [input.caseId, STALE_PENDING_TURN_INTERVAL],
      );
      if (pending.rows[0] && !pending.rows[0].stale) {
        return { state: pending.rows[0].id === turn?.id ? "in_progress" : "busy" };
      }
      if (pending.rows[0]) {
        await client.query(
          `UPDATE case_assistant_turns SET status = 'failed', updated_at = now()
           WHERE id = $1::uuid`,
          [pending.rows[0].id],
        );
      }
      if (turn) {
        const retried = await client.query<AssistantTurn>(
          `UPDATE case_assistant_turns SET status = 'pending', claim_token = gen_random_uuid(),
                  answer = NULL, analysis_run_id = NULL, source_refs = '[]'::jsonb,
                  updated_at = now(), completed_at = NULL
           WHERE id = $1::uuid RETURNING ${turnColumns}`,
          [turn.id],
        );
        return { state: "claimed", turn: retried.rows[0]! };
      }
      const created = await client.query<AssistantTurn>(
        `INSERT INTO case_assistant_turns (case_id, actor_id, question, idempotency_key)
         VALUES ($1::uuid, $2, $3, $4) RETURNING ${turnColumns}`,
        [input.caseId, input.actorId, input.question, input.idempotencyKey],
      );
      return { state: "claimed", turn: created.rows[0]! };
    });
  }

  async completeTurn(input: {
    turnId: string;
    claimToken: string;
    answer: string;
    analysisRunId: string | null;
    sourceRefs: AssistantSource[];
  }): Promise<AssistantTurn | null> {
    const result = await this.pool.query<AssistantTurn>(
      `UPDATE case_assistant_turns
       SET answer = $3, analysis_run_id = $4::uuid, source_refs = $5::jsonb,
           status = 'completed', updated_at = now(), completed_at = now()
       WHERE id = $1::uuid AND claim_token = $2::uuid AND status = 'pending'
       RETURNING ${turnColumns}`,
      [input.turnId, input.claimToken, input.answer, input.analysisRunId,
        JSON.stringify(input.sourceRefs)],
    );
    return result.rows[0] ?? null;
  }

  async failTurn(turnId: string, claimToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE case_assistant_turns SET status = 'failed', updated_at = now()
       WHERE id = $1::uuid AND claim_token = $2::uuid AND status = 'pending'`,
      [turnId, claimToken],
    );
  }

  async getReview(runId: string): Promise<AssistantReview> {
    const [findings, gaps, conflicts, citations] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT id::text, requirement_code, outcome, summary, rationale
         FROM findings WHERE analysis_run_id = $1::uuid ORDER BY created_at, id LIMIT 50`, [runId],
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT id::text, requirement_code, description, requested_evidence
         FROM evidence_gaps WHERE analysis_run_id = $1::uuid ORDER BY created_at, id LIMIT 50`, [runId],
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT id::text, subject, description
         FROM conflicts WHERE analysis_run_id = $1::uuid ORDER BY created_at, id LIMIT 50`, [runId],
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT id::text, finding_id::text, evidence_gap_id::text, conflict_id::text,
                source_kind, locator, excerpt
         FROM citations WHERE analysis_run_id = $1::uuid ORDER BY created_at, id LIMIT 100`, [runId],
      ),
    ]);
    return {
      findings: findings.rows,
      evidence_gaps: gaps.rows,
      conflicts: conflicts.rows,
      citations: citations.rows,
    };
  }

  async searchCaseEvidence(runId: string, query: string, queryEmbedding?: number[]): Promise<Record<string, unknown>[]> {
    const embedding = serializeAssistantEmbedding(queryEmbedding);
    const result = await this.pool.query<Record<string, unknown>>(
      `WITH ${queryTermsCte}, lexical_candidates AS (
         SELECT document.id AS source_id, chunk.id AS chunk_id,
                chunk.section_locator AS locator, chunk.content AS excerpt,
                document.original_filename,
                ((chunk.search_vector @@ terms.all_terms)::int
                  + ts_rank_cd(chunk.search_vector, terms.any_term))::double precision AS score,
                0 AS candidate_kind
         FROM query_terms terms
         CROSS JOIN analysis_run_documents snapshot
         JOIN case_documents document
           ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
         JOIN document_chunks chunk
           ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
         WHERE snapshot.analysis_run_id = $1::uuid
           AND (chunk.search_vector @@ terms.all_terms OR chunk.search_vector @@ terms.any_term)
         ORDER BY score DESC, chunk.id
         LIMIT 15
       ), semantic_candidates AS (
         SELECT document.id AS source_id, chunk.id AS chunk_id,
                chunk.section_locator AS locator, chunk.content AS excerpt,
                document.original_filename,
                (1 - (assistant_embedding.embedding <=> $3::vector))::double precision AS score,
                1 AS candidate_kind
         FROM analysis_run_documents snapshot
         JOIN case_documents document
           ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
         JOIN document_chunks chunk
           ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
         JOIN assistant_document_embeddings assistant_embedding
           ON assistant_embedding.chunk_id = chunk.id
         WHERE snapshot.analysis_run_id = $1::uuid
           AND $3::vector IS NOT NULL
           AND assistant_embedding.provider = 'cohere'
           AND assistant_embedding.model = 'embed-english-v3.0'
         ORDER BY assistant_embedding.embedding <=> $3::vector, chunk.id
         LIMIT 15
       ), candidates AS (
         SELECT * FROM lexical_candidates
         UNION ALL
         SELECT * FROM semantic_candidates
       ), unique_candidates AS (
         SELECT DISTINCT ON (chunk_id) *
         FROM candidates
         ORDER BY chunk_id, candidate_kind, score DESC
       )
       SELECT source_id::text, chunk_id::text, locator, excerpt, original_filename
       FROM unique_candidates
       ORDER BY candidate_kind, score DESC, chunk_id
       LIMIT 30`,
      [runId, query, embedding],
    );
    return result.rows;
  }

  async searchPolicyEvidence(runId: string, query: string, queryEmbedding?: number[]): Promise<Record<string, unknown>[]> {
    const embedding = serializeAssistantEmbedding(queryEmbedding);
    const result = await this.pool.query<Record<string, unknown>>(
      `WITH ${queryTermsCte}, run_scope AS (
         SELECT run.id, run.case_snapshot
         FROM analysis_runs run
         WHERE run.id = $1::uuid
       ), lexical_candidates AS (
         SELECT version.id AS source_id, chunk.id AS chunk_id,
                chunk.section_locator AS locator, chunk.content AS excerpt,
                policy.code, version.version,
                ((chunk.search_vector @@ terms.all_terms)::int
                  + ts_rank_cd(chunk.search_vector, terms.any_term))::double precision AS score,
                0 AS candidate_kind
         FROM query_terms terms
         CROSS JOIN run_scope run
         JOIN analysis_run_policy_versions snapshot ON snapshot.analysis_run_id = run.id
         JOIN policy_versions version ON version.id = snapshot.policy_version_id
         JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
         JOIN policy_documents policy ON policy.id = version.policy_document_id
         WHERE ('*' = ANY(chunk.jurisdictions)
             OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
           AND ('*' = ANY(chunk.products)
             OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
           AND ('*' = ANY(chunk.business_types)
             OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
           AND (chunk.search_vector @@ terms.all_terms OR chunk.search_vector @@ terms.any_term)
         ORDER BY score DESC, chunk.id
         LIMIT 15
       ), semantic_candidates AS (
         SELECT version.id AS source_id, chunk.id AS chunk_id,
                chunk.section_locator AS locator, chunk.content AS excerpt,
                policy.code, version.version,
                (1 - (assistant_embedding.embedding <=> $3::vector))::double precision AS score,
                1 AS candidate_kind
         FROM run_scope run
         JOIN analysis_run_policy_versions snapshot ON snapshot.analysis_run_id = run.id
         JOIN policy_versions version ON version.id = snapshot.policy_version_id
         JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
         JOIN assistant_policy_embeddings assistant_embedding
           ON assistant_embedding.chunk_id = chunk.id
         JOIN policy_documents policy ON policy.id = version.policy_document_id
         WHERE ('*' = ANY(chunk.jurisdictions)
             OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
           AND ('*' = ANY(chunk.products)
             OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
           AND ('*' = ANY(chunk.business_types)
             OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
           AND $3::vector IS NOT NULL
           AND assistant_embedding.provider = 'cohere'
           AND assistant_embedding.model = 'embed-english-v3.0'
         ORDER BY assistant_embedding.embedding <=> $3::vector, chunk.id
         LIMIT 15
       ), candidates AS (
         SELECT * FROM lexical_candidates
         UNION ALL
         SELECT * FROM semantic_candidates
       ), unique_candidates AS (
         SELECT DISTINCT ON (chunk_id) *
         FROM candidates
         ORDER BY chunk_id, candidate_kind, score DESC
       )
       SELECT source_id::text, chunk_id::text, locator, excerpt, code, version
       FROM unique_candidates
       ORDER BY candidate_kind, score DESC, chunk_id
       LIMIT 30`,
      [runId, query, embedding],
    );
    return result.rows;
  }

  async searchAcceptedWebEvidence(runId: string, query: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `WITH ${queryTermsCte}, accepted AS (
         SELECT evidence.id, evidence.title, evidence.publisher, evidence.url,
                evidence.excerpt, evidence.retrieved_at,
                to_tsvector('english', evidence.title || ' ' || evidence.publisher || ' ' || evidence.excerpt)
                  AS search_vector
         FROM external_web_evidence evidence
         JOIN web_result_review_items review
           ON review.external_web_evidence_id = evidence.id
          AND review.analysis_run_id = evidence.analysis_run_id
          AND review.review_state = 'accepted'
         WHERE evidence.analysis_run_id = $1::uuid
       )
       SELECT accepted.id::text, accepted.title, accepted.publisher, accepted.url,
              left(accepted.excerpt, 1500) AS excerpt, accepted.retrieved_at
       FROM accepted CROSS JOIN query_terms terms
       WHERE accepted.search_vector @@ terms.all_terms OR accepted.search_vector @@ terms.any_term
       ORDER BY (accepted.search_vector @@ terms.all_terms)::int
                  + ts_rank_cd(accepted.search_vector, terms.any_term) DESC,
                accepted.retrieved_at DESC, accepted.id
       LIMIT 15`,
      [runId, query],
    );
    return result.rows;
  }

  async listUnembeddedChunks(runId: string, limit: number): Promise<AssistantEmbeddingChunk[]> {
    const result = await this.pool.query<AssistantEmbeddingChunk>(
      `WITH document_pending AS (
         SELECT DISTINCT chunk.id, chunk.content, 'document'::text AS kind
         FROM analysis_run_documents snapshot
         JOIN document_chunks chunk
           ON chunk.document_id = snapshot.document_id AND chunk.case_id = snapshot.case_id
         LEFT JOIN assistant_document_embeddings stored ON stored.chunk_id = chunk.id
         WHERE snapshot.analysis_run_id = $1::uuid
           AND length(trim(chunk.content)) > 0
           AND (stored.chunk_id IS NULL OR stored.provider <> 'cohere'
             OR stored.model <> 'embed-english-v3.0')
       ), policy_pending AS (
         SELECT DISTINCT chunk.id, chunk.content, 'policy'::text AS kind
         FROM analysis_runs run
         JOIN analysis_run_policy_versions snapshot ON snapshot.analysis_run_id = run.id
         JOIN policy_chunks chunk ON chunk.policy_version_id = snapshot.policy_version_id
         LEFT JOIN assistant_policy_embeddings stored ON stored.chunk_id = chunk.id
         WHERE run.id = $1::uuid
           AND ('*' = ANY(chunk.jurisdictions)
             OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
           AND ('*' = ANY(chunk.products)
             OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
           AND ('*' = ANY(chunk.business_types)
             OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
           AND length(trim(chunk.content)) > 0
           AND (stored.chunk_id IS NULL OR stored.provider <> 'cohere'
             OR stored.model <> 'embed-english-v3.0')
       )
       SELECT id::text, kind, content FROM (
         SELECT * FROM document_pending UNION ALL SELECT * FROM policy_pending
       ) pending
       ORDER BY kind, id
       LIMIT $2`,
      [runId, limit],
    );
    return result.rows;
  }

  async storeEmbeddings(rows: { id: string; kind: AssistantEmbeddingChunk["kind"]; embedding: number[] }[]): Promise<void> {
    if (rows.length === 0) return;
    await this.transaction(async (client) => {
      for (const row of rows) {
        const table = row.kind === "document" ? "assistant_document_embeddings" : "assistant_policy_embeddings";
        await client.query(
          `INSERT INTO ${table} (chunk_id, embedding, provider, model)
           VALUES ($1::uuid, $2::vector, 'cohere', 'embed-english-v3.0')
           ON CONFLICT (chunk_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, provider = EXCLUDED.provider,
               model = EXCLUDED.model, created_at = clock_timestamp()`,
          [row.id, serializeStoredEmbedding(row.embedding)],
        );
      }
    });
  }
}

function serializeStoredEmbedding(embedding: number[]): string {
  const serialized = serializeAssistantEmbedding(embedding);
  if (!serialized) throw new Error("assistant_document_embedding_required");
  return serialized;
}

function serializeAssistantEmbedding(embedding?: number[]): string | null {
  if (embedding === undefined) return null;
  if (embedding.length !== 1024 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("assistant_query_embedding_must_have_1024_finite_values");
  }
  return `[${embedding.join(",")}]`;
}

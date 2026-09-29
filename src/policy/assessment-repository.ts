import type { Pool } from "pg";

import {
  declaredAnswers,
  selectEvidence,
  type AssessmentContext,
  type AssessmentProposal,
  type RankedChunk,
} from "./assessment.ts";

export interface StoredAssessment {
  id: string;
  analysis_run_id: string;
  case_id: string;
  policy_chunk_id: string;
  document_id: string;
  model: string;
  proposal: AssessmentProposal;
  review_state: "pending_review" | "accepted" | "rejected";
  reviewed_by: string | null;
  review_rationale: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

export interface AssessmentRepository {
  listCandidates(runId: string): Promise<{
    policy_passages: Array<{ chunk_id: string; version_id: string; locator: string; content: string }>;
    documents: Array<{ document_id: string; document_type: string; original_filename: string; chunk_count: number }>;
  }>;
  getContext(runId: string, policyChunkId: string, documentId: string): Promise<AssessmentContext | null>;
  save(input: {
    context: AssessmentContext;
    model: string;
    proposal: AssessmentProposal;
  }): Promise<StoredAssessment>;
  list(runId: string): Promise<StoredAssessment[]>;
  listAccepted(runId: string): Promise<StoredAssessment[]>;
  review(input: {
    runId: string;
    proposalId: string;
    decision: "accepted" | "rejected";
    actorId: string;
    rationale: string;
  }): Promise<StoredAssessment | null>;
}

/** Proposals stored before declaration conflicts were reported read as having none. */
function normalize(row: StoredAssessment): StoredAssessment {
  return { ...row, proposal: { ...row.proposal, declaration_conflicts: row.proposal.declaration_conflicts ?? [] } };
}

export class PostgresAssessmentRepository implements AssessmentRepository {
  constructor(private readonly pool: Pool) {}

  async listCandidates(runId: string) {
    const [policies, documents] = await Promise.all([
      this.pool.query<{ chunk_id: string; version_id: string; locator: string; content: string }>(
        `SELECT chunk.id::text AS chunk_id, version.id::text AS version_id,
                chunk.section_locator AS locator, chunk.content
         FROM analysis_runs run
         JOIN analysis_run_policy_versions pinned ON pinned.analysis_run_id = run.id
         JOIN policy_versions version ON version.id = pinned.policy_version_id
         JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
         WHERE run.id = $1::uuid
           AND version.effective_from <= run.policy_effective_on
           AND (version.effective_to IS NULL OR version.effective_to >= run.policy_effective_on)
           AND NOT version.superseded
           AND ('*' = ANY(chunk.jurisdictions)
             OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
           AND ('*' = ANY(chunk.products)
             OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
           AND ('*' = ANY(chunk.business_types)
             OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
           AND policy_chunk_scope_eligible(run.id, chunk.id)
         ORDER BY version.id, chunk.chunk_index`,
        [runId],
      ),
      this.pool.query<{ document_id: string; document_type: string; original_filename: string; chunk_count: number }>(
        `SELECT document.id::text AS document_id, document.document_type, document.original_filename,
                count(chunk.id)::int AS chunk_count
         FROM analysis_runs run
         JOIN analysis_run_documents pinned
           ON pinned.analysis_run_id = run.id AND pinned.case_id = run.case_id
         JOIN case_documents document
           ON document.id = pinned.document_id AND document.case_id = pinned.case_id
         LEFT JOIN document_chunks chunk
           ON chunk.document_id = document.id AND chunk.case_id = document.case_id
         WHERE run.id = $1::uuid AND document.ingestion_status = 'ready'
         GROUP BY document.id, document.document_type, document.original_filename
         ORDER BY document.original_filename, document.id`,
        [runId],
      ),
    ]);
    return { policy_passages: policies.rows, documents: documents.rows };
  }

  async getContext(runId: string, policyChunkId: string, documentId: string): Promise<AssessmentContext | null> {
    const policy = await this.pool.query<{
      analysis_run_id: string;
      case_id: string;
      chunk_id: string;
      version_id: string;
      locator: string;
      content: string;
      activity_declaration: unknown;
    }>(
      `SELECT run.id::text AS analysis_run_id, run.case_id::text,
              chunk.id::text AS chunk_id, version.id::text AS version_id,
              chunk.section_locator AS locator, chunk.content,
              run.case_snapshot #> '{submitted_payload,activity_declaration}' AS activity_declaration
       FROM analysis_runs run
       JOIN analysis_run_policy_versions pinned ON pinned.analysis_run_id = run.id
       JOIN policy_versions version ON version.id = pinned.policy_version_id
       JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
       WHERE run.id = $1::uuid AND chunk.id = $2::uuid
         AND version.effective_from <= run.policy_effective_on
         AND (version.effective_to IS NULL OR version.effective_to >= run.policy_effective_on)
         AND NOT version.superseded
         AND ('*' = ANY(chunk.jurisdictions)
           OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
         AND ('*' = ANY(chunk.products)
           OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
         AND ('*' = ANY(chunk.business_types)
           OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
         AND policy_chunk_scope_eligible(run.id, chunk.id)`,
      [runId, policyChunkId],
    );
    const selectedPolicy = policy.rows[0];
    if (!selectedPolicy) return null;
    const document = await this.pool.query<{ id: string; original_filename: string }>(
      `SELECT document.id::text, document.original_filename
       FROM analysis_run_documents pinned
       JOIN case_documents document
         ON document.id = pinned.document_id AND document.case_id = pinned.case_id
       WHERE pinned.analysis_run_id = $1::uuid AND pinned.case_id = $2::uuid
         AND document.id = $3::uuid
         AND document.ingestion_status = 'ready'`,
      [runId, selectedPolicy.case_id, documentId],
    );
    const selectedDocument = document.rows[0];
    if (!selectedDocument) return null;
    const chunks = await this.pool.query<RankedChunk>(
      `SELECT chunk.id::text, chunk.section_locator AS locator, chunk.content,
              CASE WHEN chunk.embedding IS NOT NULL AND policy.embedding IS NOT NULL
                     AND vector_dims(chunk.embedding) = vector_dims(policy.embedding)
                THEN 1 - (chunk.embedding <=> policy.embedding) END AS relevance
       FROM document_chunks chunk
       CROSS JOIN policy_chunks policy
       WHERE chunk.document_id = $1::uuid AND chunk.case_id = $2::uuid AND policy.id = $3::uuid
       ORDER BY chunk.chunk_index`,
      [documentId, selectedPolicy.case_id, selectedPolicy.chunk_id],
    );
    const evidence = selectEvidence(chunks.rows);
    const facts = await this.pool.query<{
      id: string; chunk_id: string; subject: string; predicate: string; value: string;
    }>(
      `SELECT id::text, chunk_id::text, subject, predicate, value
       FROM case_document_facts
       WHERE document_id = $1::uuid AND case_id = $2::uuid AND chunk_id = ANY($3::uuid[])
       ORDER BY created_at, id`,
      [documentId, selectedPolicy.case_id, evidence.chunks.map((chunk) => chunk.id)],
    );
    return {
      analysis_run_id: selectedPolicy.analysis_run_id,
      case_id: selectedPolicy.case_id,
      policy: {
        chunk_id: selectedPolicy.chunk_id,
        version_id: selectedPolicy.version_id,
        locator: selectedPolicy.locator,
        content: selectedPolicy.content,
      },
      declaration: declaredAnswers(selectedPolicy.activity_declaration),
      document: {
        id: selectedDocument.id,
        original_filename: selectedDocument.original_filename,
        chunks: evidence.chunks,
        ...(evidence.selection ? { selection: evidence.selection } : {}),
        facts: facts.rows,
      },
    };
  }

  async save(input: {
    context: AssessmentContext;
    model: string;
    proposal: AssessmentProposal;
  }): Promise<StoredAssessment> {
    const result = await this.pool.query<StoredAssessment>(
      `INSERT INTO policy_assessment_proposals (
         analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb)
       RETURNING *`,
      [
        input.context.analysis_run_id, input.context.case_id,
        input.context.policy.chunk_id, input.context.document.id,
        input.model, JSON.stringify(input.proposal),
      ],
    );
    return normalize(result.rows[0]!);
  }

  async list(runId: string): Promise<StoredAssessment[]> {
    const result = await this.pool.query<StoredAssessment>(
      `SELECT * FROM policy_assessment_proposals
       WHERE analysis_run_id = $1::uuid
       ORDER BY created_at DESC, id DESC`,
      [runId],
    );
    return result.rows.map(normalize);
  }

  async listAccepted(runId: string): Promise<StoredAssessment[]> {
    const result = await this.pool.query<StoredAssessment>(
      `SELECT * FROM accepted_policy_assessments_for_run($1::uuid)
       ORDER BY reviewed_at, id`,
      [runId],
    );
    return result.rows.map(normalize);
  }

  async review(input: {
    runId: string;
    proposalId: string;
    decision: "accepted" | "rejected";
    actorId: string;
    rationale: string;
  }): Promise<StoredAssessment | null> {
    const result = await this.pool.query<StoredAssessment>(
      `UPDATE policy_assessment_proposals
       SET review_state = $3, reviewed_by = $4, review_rationale = $5,
           reviewed_at = now()
       WHERE analysis_run_id = $1::uuid AND id = $2::uuid
         AND review_state = 'pending_review'
       RETURNING *`,
      [input.runId, input.proposalId, input.decision, input.actorId, input.rationale],
    );
    return result.rows[0] ? normalize(result.rows[0]) : null;
  }
}

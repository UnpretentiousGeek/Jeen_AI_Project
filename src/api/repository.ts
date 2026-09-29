import type { Pool, PoolClient } from "pg";

import type {
  AnalysisRunRecord,
  CreateCaseInput,
  LangflowInvocation,
  OpenableSourceKind,
  PendingCheckpoint,
} from "./contracts.ts";
import { TERMINAL_UNSUCCESSFUL_JOB_STATUSES } from "../workflow/langflow-client.ts";
import { buildAgentTasks } from "./agent-activity.ts";
import { CASE_STATUSES_OPEN_FOR_ANALYSIS } from "../case-catalog.ts";
import { buildReviewPath } from "./review-path.ts";
import { runSourceLabels, withCitationSourceLabels, type RunSource } from "../source-labels.ts";
import { activityDeclarationSchema, evaluateRuleScope, providerProfileSchema,
  type ProviderProfile } from "../policy/applicability.ts";

type JsonObject = Record<string, unknown>;

// The durable coordinator accepts one skip per checkpoint request; a second skip conflicts in persistence.
const LATEST_CHECKPOINT_SKIP_SQL = `
  SELECT checkpoint_skip.skipped_at
  FROM coordinator_v3_checkpoint_skips checkpoint_skip
  JOIN coordinator_v3_runs skip_run ON skip_run.id = checkpoint_skip.run_id
  WHERE skip_run.analysis_run_id = checkpoint.analysis_run_id
    AND checkpoint_skip.request_id = checkpoint.request_id
  ORDER BY checkpoint_skip.skipped_at DESC LIMIT 1`;

function rows<T extends JsonObject>(value: T[]): T[] {
  return value;
}

function policyReview(contributions: JsonObject[]): JsonObject | null {
  const latest = contributions.filter((item) => item.specialty === "policy"
    && (item.status === "completed" || item.status === "partial")).at(-1);
  const payload = latest?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as JsonObject;
  if (!Array.isArray(value.requirement_evidence_matrix) || !Array.isArray(value.citations)) return null;
  return {
    status: latest.status,
    coverage_note: typeof value.coverage_note === "string" ? value.coverage_note : null,
    policy_effective_on: value.policy_effective_on ?? null,
    pinned_policy_versions: Array.isArray(value.pinned_policy_versions) ? value.pinned_policy_versions : [],
    requirements: value.requirement_evidence_matrix,
    citations: value.citations,
  };
}

export interface CaseRepository {
  getProviderProfile(): Promise<ProviderProfile | null>;
  saveProviderProfile(input: ProviderProfile): Promise<ProviderProfile>;
  listRuleApplicability(runId: string): Promise<JsonObject[]>;
  createCase(input: CreateCaseInput): Promise<JsonObject>;
  listCases(): Promise<JsonObject[]>;
  getCase(caseId: string): Promise<JsonObject | null>;
  setCaseArchived(caseId: string, archived: boolean, actorId: string): Promise<JsonObject | null>;
  deleteArchivedCase(caseId: string): Promise<{
    case_id: string;
    storage_paths: string[];
    applicant_id: string;
    application_id: string;
  } | null>;
  getCaseTimeline(caseId: string, limit: number, offset: number): Promise<JsonObject[]>;
  getDocumentForDownload(caseId: string, documentId: string): Promise<JsonObject | null>;
  deleteCaseDocument(caseId: string, documentId: string): Promise<{
    storage_path: string;
    original_filename: string;
    checksum_sha256: string;
  } | null>;
  getSource(runId: string, sourceKind: OpenableSourceKind, sourceId: string): Promise<JsonObject | null>;
  getEvidenceReadiness(caseId: string): Promise<JsonObject | null>;
  reserveEvidenceInvocation(input: {
    caseId: string;
    checksumSha256: string;
    originalFilename: string;
    documentType: string;
    idempotencyKey: string;
    flowId: string;
    sessionId: string;
  }): Promise<void>;
  finishEvidenceInvocation(idempotencyKey: string, jobId: string, status: string): Promise<void>;
  failEvidenceInvocation(idempotencyKey: string): Promise<void>;
  recordFinalDecision(input: {
    caseId: string;
    analysisRunId: string;
    decision: "approved" | "rejected";
    actorId: string;
    rationale: string;
    idempotencyKey: string;
  }): Promise<JsonObject>;
  startAnalysis(input: {
    caseId: string;
    sessionId: string;
    analystInstructions: string | null;
  }): Promise<AnalysisRunRecord>;
  getRun(runId: string): Promise<JsonObject | null>;
  getRunIdentity(runId: string): Promise<(AnalysisRunRecord & {
    task_objective: string;
    coordinator_flow_id: string | null;
  }) | null>;
  getPendingCheckpoint(runId: string, requestId: string): Promise<PendingCheckpoint | null>;
  hasAcceptedPolicyAssessment(runId: string): Promise<boolean>;
  recordCheckpointSkip(input: {
    runId: string;
    requestId: string;
    expectedStateVersion: number | string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<void>;
  recordInvocation(input: {
    caseId: string;
    analysisRunId?: string;
    evidenceSubmissionId?: string;
    purpose: LangflowInvocation["purpose"];
    flowId: string;
    jobId: string;
    sessionId: string;
    status: string;
    idempotencyKey: string;
  }): Promise<void>;
  updateInvocationStatus(jobId: string, status: string, failureReason?: string | null): Promise<void>;
  markExecutionFailed(runId: string, jobId: string): Promise<{ recovered: boolean }>;
  markLaunchFailed(runId: string, message: string): Promise<void>;
}

export class PostgresCaseRepository implements CaseRepository {
  constructor(private readonly pool: Pool) {}

  async getProviderProfile(): Promise<ProviderProfile | null> {
    const result = await this.pool.query<ProviderProfile>(
      `SELECT legal_name, regulated_roles, service_jurisdictions
       FROM onboarding_provider_profile WHERE id = 1`,
    );
    return result.rows[0] ?? null;
  }

  async saveProviderProfile(input: ProviderProfile): Promise<ProviderProfile> {
    const result = await this.pool.query<ProviderProfile>(
      `INSERT INTO onboarding_provider_profile
         (id, legal_name, regulated_roles, service_jurisdictions)
       VALUES (1, $1, $2::text[], $3::text[])
       ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name,
         regulated_roles = EXCLUDED.regulated_roles,
         service_jurisdictions = EXCLUDED.service_jurisdictions,
         updated_at = now()
       RETURNING legal_name, regulated_roles, service_jurisdictions`,
      [input.legal_name, input.regulated_roles, input.service_jurisdictions],
    );
    return result.rows[0]!;
  }

  async listRuleApplicability(runId: string): Promise<JsonObject[]> {
    const result = await this.pool.query<{
      case_snapshot: JsonObject;
      id: string;
      code: string;
      statement: string;
      rule_kind: string;
      policy_chunk_id: string;
      policy_version_id: string;
      section_locator: string;
      source_excerpt: string;
      source_path: string;
      jurisdictions: string[];
      products: string[];
      business_types: string[];
      provider_roles: string[];
      provider_jurisdictions: string[];
      applicant_payment_activities: string[];
      operating_jurisdictions: string[];
      funds_handling: "yes" | "no" | null;
    }>(
      `SELECT run.case_snapshot, rule.id::text, rule.code, rule.statement, rule.rule_kind,
              chunk.id::text AS policy_chunk_id, version.id::text AS policy_version_id,
              chunk.section_locator, rule.source_excerpt, version.source_path,
              chunk.jurisdictions, chunk.products, chunk.business_types,
              rule.provider_roles, rule.provider_jurisdictions,
              rule.applicant_payment_activities, rule.operating_jurisdictions,
              rule.funds_handling
       FROM analysis_runs run
       JOIN analysis_run_policy_versions pinned ON pinned.analysis_run_id = run.id
       JOIN policy_versions version ON version.id = pinned.policy_version_id
       JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
       JOIN policy_rule_scopes rule ON rule.policy_chunk_id = chunk.id
       WHERE run.id = $1::uuid AND rule.review_state = 'approved'
         AND rule.approved_at <= run.created_at
         AND NOT version.superseded
         AND version.effective_from <= run.policy_effective_on
         AND (version.effective_to IS NULL OR version.effective_to >= run.policy_effective_on)
       ORDER BY rule.code`,
      [runId],
    );
    return result.rows.map((row) => {
      const applicant = row.case_snapshot.applicant as JsonObject | undefined;
      const payload = row.case_snapshot.submitted_payload as JsonObject | undefined;
      const providerSnapshot = row.case_snapshot.provider as JsonObject | null | undefined;
      const provider = providerProfileSchema.safeParse(
        providerSnapshot && typeof providerSnapshot === "object" && !Array.isArray(providerSnapshot)
          ? {
              legal_name: providerSnapshot.legal_name,
              regulated_roles: providerSnapshot.regulated_roles,
              service_jurisdictions: providerSnapshot.service_jurisdictions,
            }
          : null,
      );
      const activity = activityDeclarationSchema.safeParse(payload?.activity_declaration);
      const tagChecks = [
        ["applicant jurisdiction", row.jurisdictions, applicant?.jurisdiction],
        ["product requested", row.products, applicant?.product],
        ["business type", row.business_types, applicant?.business_type],
      ] as const;
      const mismatches = tagChecks.filter(([, tags, actual]) =>
        !tags.includes("*") && !tags.includes(String(actual ?? "")));
      const scope = mismatches.length
        ? { status: "does_not_apply" as const, reasons: mismatches.map(([name]) => name) }
        : evaluateRuleScope(row, {
          provider: provider.success ? provider.data : null,
          activity: activity.success ? activity.data : null,
        });
      const { case_snapshot: _snapshot, jurisdictions: _jurisdictions, products: _products,
        business_types: _businessTypes, provider_roles: _providerRoles,
        provider_jurisdictions: _providerJurisdictions,
        applicant_payment_activities: _paymentActivities,
        operating_jurisdictions: _operatingJurisdictions,
        funds_handling: _fundsHandling, ...publicRule } = row;
      return { ...publicRule, applicability: scope.status, reasons: scope.reasons };
    });
  }

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

  async createCase(input: CreateCaseInput): Promise<JsonObject> {
    return this.transaction(async (client) => {
      const applicant = await client.query<{ id: string }>(
        `INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
         VALUES ($1, $2, $3, $4) RETURNING id::text`,
        [input.legal_name, input.jurisdiction, input.business_type, input.product],
      );
      const applicantId = applicant.rows[0]!.id;
      const application = await client.query<{ id: string }>(
        `INSERT INTO applications (applicant_id, submitted_payload)
         VALUES ($1::uuid, $2::jsonb) RETURNING id::text`,
        [applicantId, JSON.stringify(input.submitted_payload)],
      );
      const reference = `KYB-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const created = await client.query<JsonObject>(
        `INSERT INTO onboarding_cases (application_id, applicant_id, reference)
         VALUES ($1::uuid, $2::uuid, $3)
         RETURNING id::text, reference, status, created_at, updated_at`,
        [application.rows[0]!.id, applicantId, reference],
      );
      return {
        ...created.rows[0]!,
        legal_name: input.legal_name,
        jurisdiction: input.jurisdiction,
        business_type: input.business_type,
        product: input.product,
      };
    });
  }

  async listCases(): Promise<JsonObject[]> {
    const result = await this.pool.query<JsonObject>(
      `SELECT c.id::text, c.reference, c.status, c.created_at, c.updated_at, c.archived_at,
              a.legal_name, a.jurisdiction, a.business_type, a.product,
              r.id::text AS analysis_run_id, r.status AS run_status, r.created_at AS run_started_at,
              coordinator.phase AS coordinator_phase,
              checkpoint.checkpoint_kind AS pending_checkpoint_kind,
              checkpoint.request_id AS pending_checkpoint_request_id,
              COALESCE(document_count.value, 0)::integer AS evidence_count,
              COALESCE(finding_count.value, 0)::integer AS finding_count
       FROM onboarding_cases c
       JOIN applicants a ON a.id = c.applicant_id
       LEFT JOIN analysis_runs r ON r.id = c.active_analysis_run_id
       LEFT JOIN LATERAL (
         SELECT run.phase
         FROM coordinator_v3_runs run
         WHERE run.analysis_run_id = r.id AND run.engine_version = 'durable-loop-v1'
         ORDER BY run.created_at DESC LIMIT 1
       ) coordinator ON true
       LEFT JOIN LATERAL (
         SELECT cp.checkpoint_kind, cp.request_id
         FROM coordinator_v3_checkpoints cp
         WHERE cp.analysis_run_id = r.id AND cp.status = 'pending'
         ORDER BY cp.created_at DESC LIMIT 1
       ) checkpoint ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS value FROM case_documents document WHERE document.case_id = c.id
       ) document_count ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS value FROM findings finding WHERE finding.analysis_run_id = r.id
       ) finding_count ON true
       ORDER BY c.updated_at DESC, c.id DESC`,
    );
    return rows(result.rows);
  }

  async getCase(caseId: string): Promise<JsonObject | null> {
    const result = await this.pool.query<JsonObject>(
      `SELECT c.id::text, c.reference, c.status, c.created_at, c.updated_at, c.archived_at,
              a.legal_name, a.jurisdiction, a.business_type, a.product,
              app.submitted_payload, c.active_analysis_run_id::text
       FROM onboarding_cases c
       JOIN applicants a ON a.id = c.applicant_id
       JOIN applications app ON app.id = c.application_id
       WHERE c.id = $1::uuid`,
      [caseId],
    );
    const selectedCase = result.rows[0];
    if (!selectedCase) return null;
    const runId = typeof selectedCase.active_analysis_run_id === "string"
      ? selectedCase.active_analysis_run_id
      : null;
    const documents = await this.pool.query<JsonObject>(
      `SELECT id::text, document_type, original_filename, mime_type,
              checksum_sha256, ingestion_status, ingestion_error,
              source_metadata, created_at
       FROM case_documents WHERE case_id = $1::uuid ORDER BY created_at, id`,
      [caseId],
    );
    const finalDecision = await this.pool.query<JsonObject>(
      `SELECT id::text, case_id::text, analysis_run_id::text,
              decision, actor, rationale, decided_at
       FROM case_final_decisions WHERE case_id = $1::uuid`,
      [caseId],
    );
    return {
      ...selectedCase,
      documents: documents.rows,
      final_decision: finalDecision.rows[0] ?? null,
      run: runId ? await this.getRun(runId) : null,
    };
  }

  async setCaseArchived(caseId: string, archived: boolean, actorId: string): Promise<JsonObject | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<{
        id: string;
        archived_at: string | null;
        run_status: string | null;
        coordinator_phase: string | null;
        analysis_run_id: string | null;
      }>(
        `SELECT c.id::text, c.archived_at, r.status AS run_status,
                coordinator.phase AS coordinator_phase, r.id::text AS analysis_run_id
         FROM onboarding_cases c
         LEFT JOIN analysis_runs r ON r.id = c.active_analysis_run_id
         LEFT JOIN LATERAL (
           SELECT run.phase
           FROM coordinator_v3_runs run
           WHERE run.analysis_run_id = r.id
           ORDER BY run.created_at DESC LIMIT 1
         ) coordinator ON true
         WHERE c.id = $1::uuid
         FOR UPDATE OF c`,
        [caseId],
      );
      const selectedCase = selected.rows[0];
      if (!selectedCase) return null;
      if (archived && (selectedCase.run_status === "queued" || selectedCase.run_status === "running"
        || selectedCase.coordinator_phase === "running")) {
        throw new Error("case_analysis_active");
      }

      const currentlyArchived = selectedCase.archived_at !== null;
      if (currentlyArchived !== archived) {
        const updated = await client.query<JsonObject>(
          `UPDATE onboarding_cases
           SET archived_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
               archived_by = CASE WHEN $2 THEN $3 ELSE NULL END,
               updated_at = clock_timestamp()
           WHERE id = $1::uuid
           RETURNING id::text, archived_at`,
          [caseId, archived, actorId],
        );
        const eventType = archived ? "case.archived" : "case.unarchived";
        await client.query(
          `INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, actor_id, payload)
           VALUES ($1::uuid, $2::uuid, $3, 'analyst', $4, jsonb_build_object('archived', $5::boolean))`,
          [caseId, selectedCase.analysis_run_id, eventType, actorId, archived],
        );
        return updated.rows[0] ?? null;
      }
      return { id: selectedCase.id, archived_at: selectedCase.archived_at };
    });
  }

  async deleteArchivedCase(caseId: string): Promise<{
    case_id: string;
    storage_paths: string[];
    applicant_id: string;
    application_id: string;
  } | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<{
        id: string;
        applicant_id: string;
        application_id: string;
        archived_at: string | null;
        has_active_analysis: boolean;
        has_active_coordinator: boolean;
      }>(
        `SELECT c.id::text, c.applicant_id::text, c.application_id::text,
                c.archived_at,
                EXISTS (
                  SELECT 1 FROM analysis_runs run
                  WHERE run.case_id = c.id AND run.status IN ('queued', 'running')
                ) AS has_active_analysis,
                EXISTS (
                  SELECT 1 FROM coordinator_v3_runs run
                  WHERE run.case_id = c.id AND run.phase = 'running'
                ) AS has_active_coordinator
         FROM onboarding_cases c
         WHERE c.id = $1::uuid
         FOR UPDATE OF c`,
        [caseId],
      );
      const selectedCase = selected.rows[0];
      if (!selectedCase) return null;
      if (selectedCase.archived_at === null) throw new Error("case_not_archived");
      if (selectedCase.has_active_analysis || selectedCase.has_active_coordinator) {
        throw new Error("case_analysis_active");
      }

      const documents = await client.query<{ storage_path: string }>(
        `SELECT DISTINCT storage_path
         FROM case_documents
         WHERE case_id = $1::uuid
         ORDER BY storage_path`,
        [caseId],
      );
      const analysisRuns = await client.query<{ ids: string[] }>(
        `SELECT COALESCE(array_agg(id::text), ARRAY[]::text[]) AS ids
         FROM analysis_runs
         WHERE case_id = $1::uuid`,
        [caseId],
      );
      const coordinatorRuns = await client.query<{ ids: string[] }>(
        `SELECT COALESCE(array_agg(id::text), ARRAY[]::text[]) AS ids
         FROM coordinator_v3_runs
         WHERE case_id = $1::uuid`,
        [caseId],
      );

      await client.query(
        `SELECT set_config('jeen.case_purge_id', $1, true),
                set_config('jeen.case_purge_analysis_run_ids', $2, true),
                set_config('jeen.case_purge_coordinator_run_ids', $3, true)`,
        [selectedCase.id, JSON.stringify(analysisRuns.rows[0]?.ids ?? []),
          JSON.stringify(coordinatorRuns.rows[0]?.ids ?? [])],
      );

      // Final decisions also reference the case's active run, so remove that
      // immutable row before clearing the cyclic active-run pointer.
      await client.query(`DELETE FROM case_final_decisions WHERE case_id = $1::uuid`, [caseId]);
      await client.query(
        `UPDATE onboarding_cases
         SET active_analysis_run_id = NULL
         WHERE id = $1::uuid`,
        [caseId],
      );
      await client.query(`DELETE FROM onboarding_cases WHERE id = $1::uuid`, [caseId]);

      // Applicant records can be shared by multiple cases. Remove the
      // application only when no case still owns it, then remove the applicant
      // only when nothing else references it.
      await client.query(
        `DELETE FROM applications application
         WHERE application.id = $1::uuid
           AND NOT EXISTS (
             SELECT 1 FROM onboarding_cases c WHERE c.application_id = application.id
           )`,
        [selectedCase.application_id],
      );
      await client.query(
        `DELETE FROM applicants applicant
         WHERE applicant.id = $1::uuid
           AND NOT EXISTS (
             SELECT 1 FROM applications application WHERE application.applicant_id = applicant.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM onboarding_cases c WHERE c.applicant_id = applicant.id
           )`,
        [selectedCase.applicant_id],
      );

      return {
        case_id: selectedCase.id,
        storage_paths: documents.rows.map((document) => document.storage_path),
        applicant_id: selectedCase.applicant_id,
        application_id: selectedCase.application_id,
      };
    });
  }

  async getCaseTimeline(caseId: string, limit: number, offset: number): Promise<JsonObject[]> {
    const result = await this.pool.query<JsonObject>(
      `WITH timeline AS (
         SELECT 'case:' || c.id::text AS id, c.id AS case_id, NULL::uuid AS analysis_run_id,
                'case.created' AS event_type, 'system' AS actor_type, NULL::text AS actor_id,
                c.created_at AS occurred_at, jsonb_build_object('reference', c.reference) AS details
         FROM onboarding_cases c WHERE c.id = $1::uuid
         UNION ALL
         SELECT 'submission:' || s.id::text, s.case_id, NULL::uuid,
                'evidence.submitted', 'analyst', s.submitted_by, s.created_at,
                jsonb_build_object('submission_number', s.submission_number)
         FROM evidence_submissions s WHERE s.case_id = $1::uuid
         UNION ALL
         SELECT 'document:' || d.id::text, d.case_id, NULL::uuid,
                'document.uploaded', 'analyst', NULL::text, d.created_at,
                jsonb_build_object('document_id', d.id, 'filename', d.original_filename,
                                   'document_type', d.document_type)
         FROM case_documents d WHERE d.case_id = $1::uuid
         UNION ALL
         SELECT 'run:' || r.id::text, r.case_id, r.id,
                'analysis.started', 'system', NULL::text, r.created_at,
                '{}'::jsonb
         FROM analysis_runs r WHERE r.case_id = $1::uuid
         UNION ALL
         SELECT 'task:' || t.id::text, r.case_id, t.analysis_run_id,
                'task.' || t.event_type, 'workflow', t.specialty, t.occurred_at,
                jsonb_build_object('task_id', t.task_id, 'specialty', t.specialty,
                                   'attempt', t.attempt, 'details', t.details)
         FROM coordinator_v3_task_events t
         JOIN analysis_runs r ON r.id = t.analysis_run_id
         WHERE r.case_id = $1::uuid
         UNION ALL
         SELECT 'coordinator:' || e.event_id::text, e.case_id, e.analysis_run_id,
                e.event_type, 'workflow', NULL::text, e.occurred_at,
                jsonb_build_object('iteration_no', e.iteration_no, 'payload', e.payload)
         FROM coordinator_v3_events e WHERE e.case_id = $1::uuid
         UNION ALL
         SELECT 'checkpoint:' || c.id::text, c.case_id, c.analysis_run_id,
                'checkpoint.requested', 'workflow', NULL::text, c.created_at,
                jsonb_build_object('request_id', c.request_id,
                                   'checkpoint_kind', c.checkpoint_kind, 'prompt', c.prompt)
         FROM coordinator_v3_checkpoints c WHERE c.case_id = $1::uuid
         UNION ALL
         SELECT 'decision:' || h.id::text, r.case_id, r.analysis_run_id,
                'checkpoint.decided', 'analyst', h.actor_id, h.applied_at,
                jsonb_build_object('request_id', h.request_id, 'decision', h.decision)
         FROM coordinator_v3_human_decisions h
         JOIN coordinator_v3_runs r ON r.id = h.run_id
         WHERE r.case_id = $1::uuid
         UNION ALL
         SELECT 'action:' || a.id::text, a.case_id, a.analysis_run_id,
                'action.' || a.status, 'system', NULL::text, a.executed_at,
                jsonb_build_object('proposed_action_id', a.proposed_action_id,
                                   'result', a.result)
         FROM coordinator_v3_action_results a WHERE a.case_id = $1::uuid
         UNION ALL
         SELECT 'audit:' || a.id::text, a.case_id, a.analysis_run_id,
                a.event_type, a.actor_type, a.actor_id, a.created_at, a.payload
         FROM audit_events a WHERE a.case_id = $1::uuid
       )
       SELECT id, analysis_run_id::text, event_type, actor_type, actor_id, occurred_at, details
       FROM timeline ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [caseId, limit, offset],
    );
    return result.rows;
  }

  async getDocumentForDownload(caseId: string, documentId: string): Promise<JsonObject | null> {
    const result = await this.pool.query<JsonObject>(
      `SELECT id::text, case_id::text, original_filename, mime_type,
              checksum_sha256, storage_path
       FROM case_documents WHERE case_id = $1::uuid AND id = $2::uuid`,
      [caseId, documentId],
    );
    return result.rows[0] ?? null;
  }

  async deleteCaseDocument(caseId: string, documentId: string): Promise<{
    storage_path: string;
    original_filename: string;
    checksum_sha256: string;
  } | null> {
    return this.transaction(async (client) => {
      const selectedCase = await client.query<{ status: string }>(
        `SELECT status FROM onboarding_cases WHERE id = $1::uuid FOR UPDATE`,
        [caseId],
      );
      if (!selectedCase.rows[0]) return null;
      if (selectedCase.rows[0].status !== "draft") {
        throw new Error("evidence_delete_unavailable");
      }
      const startedAnalysis = await client.query<{ started: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM analysis_runs WHERE case_id = $1::uuid) AS started`,
        [caseId],
      );
      if (startedAnalysis.rows[0]?.started) throw new Error("evidence_delete_unavailable");

      const selectedDocument = await client.query<{
        storage_path: string;
        original_filename: string;
        checksum_sha256: string;
      }>(
        `SELECT storage_path, original_filename, checksum_sha256
         FROM case_documents
         WHERE case_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        [caseId, documentId],
      );
      const document = selectedDocument.rows[0];
      if (!document) return null;

      const pinned = await client.query<{ pinned: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM analysis_run_documents
           WHERE case_id = $1::uuid AND document_id = $2::uuid
         ) AS pinned`,
        [caseId, documentId],
      );
      if (pinned.rows[0]?.pinned) throw new Error("document_pinned");

      // Citations hold a direct FK to chunks. A valid citation should belong to
      // a run that pinned this document, but guard legacy or malformed rows too.
      const cited = await client.query<{ cited: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM citations citation
           JOIN document_chunks chunk ON chunk.id = citation.document_chunk_id
           WHERE chunk.case_id = $1::uuid AND chunk.document_id = $2::uuid
         ) AS cited`,
        [caseId, documentId],
      );
      if (cited.rows[0]?.cited) throw new Error("document_pinned");

      const latestInvocation = await client.query<{ status: string }>(
        `SELECT status
         FROM api_langflow_invocations
         WHERE case_id = $1::uuid
           AND purpose = 'evidence_ingestion'
           AND evidence_checksum_sha256 = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [caseId, document.checksum_sha256],
      );
      if (["queued", "in_progress", "suspended"].includes(latestInvocation.rows[0]?.status ?? "")) {
        throw new Error("evidence_processing");
      }

      // The current schema enforces one document per case and checksum. Keep
      // this guard so file and readiness cleanup remain safe on older databases.
      const duplicateChecksum = await client.query<{ duplicate: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM case_documents
           WHERE case_id = $1::uuid AND checksum_sha256 = $2 AND id <> $3::uuid
         ) AS duplicate`,
        [caseId, document.checksum_sha256, documentId],
      );
      if (duplicateChecksum.rows[0]?.duplicate) throw new Error("document_checksum_shared");

      await client.query(
        `DELETE FROM document_chunks WHERE case_id = $1::uuid AND document_id = $2::uuid`,
        [caseId, documentId],
      );
      const deleted = await client.query<{
        storage_path: string;
        original_filename: string;
        checksum_sha256: string;
      }>(
        `DELETE FROM case_documents
         WHERE case_id = $1::uuid AND id = $2::uuid
         RETURNING storage_path, original_filename, checksum_sha256`,
        [caseId, documentId],
      );
      await client.query(
        `DELETE FROM api_langflow_invocations
         WHERE case_id = $1::uuid
           AND purpose = 'evidence_ingestion'
           AND evidence_checksum_sha256 = $2`,
        [caseId, document.checksum_sha256],
      );
      return deleted.rows[0] ?? null;
    });
  }

  async getSource(runId: string, sourceKind: OpenableSourceKind, sourceId: string): Promise<JsonObject | null> {
    const queries: Record<OpenableSourceKind, string> = {
      case_document: `
        SELECT 'case_document' AS source_kind, chunk.id::text AS source_id,
               document.case_id::text, document.id::text AS document_id,
               document.original_filename, document.document_type,
               document.mime_type, document.source_metadata,
               chunk.page_number, chunk.section_locator AS locator, chunk.content
        FROM analysis_run_documents pinned
        JOIN document_chunks chunk ON chunk.document_id = pinned.document_id
          AND chunk.case_id = pinned.case_id
        JOIN case_documents document ON document.id = chunk.document_id
          AND document.case_id = chunk.case_id
        WHERE pinned.analysis_run_id = $1::uuid AND chunk.id = $2::uuid`,
      policy: `
        SELECT 'policy' AS source_kind, chunk.id::text AS source_id,
               document.code AS policy_code, document.title AS policy_title,
               version.id::text AS policy_version_id, version.version,
               version.effective_from, version.effective_to,
               chunk.section_locator AS locator, chunk.content
        FROM analysis_run_policy_versions pinned
        JOIN analysis_runs run ON run.id = pinned.analysis_run_id
        JOIN policy_chunks chunk ON chunk.policy_version_id = pinned.policy_version_id
        JOIN policy_versions version ON version.id = chunk.policy_version_id
        JOIN policy_documents document ON document.id = version.policy_document_id
        WHERE pinned.analysis_run_id = $1::uuid AND chunk.id = $2::uuid
          AND ('*' = ANY(chunk.jurisdictions)
            OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
          AND ('*' = ANY(chunk.products)
            OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
          AND ('*' = ANY(chunk.business_types)
            OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))`,
      external_web: `
        SELECT 'external_web' AS source_kind, evidence.id::text AS source_id,
               evidence.url, evidence.canonical_url, evidence.title,
               evidence.publisher, evidence.published_at, evidence.retrieved_at,
               evidence.excerpt, evidence.content_hash, evidence.retrieval_method
        FROM external_web_evidence evidence
        JOIN web_result_review_items reviewed
          ON reviewed.external_web_evidence_id = evidence.id
         AND reviewed.review_state = 'accepted'
        WHERE evidence.analysis_run_id = $1::uuid AND evidence.id = $2::uuid`,
    };
    const result = await this.pool.query<JsonObject>(queries[sourceKind], [runId, sourceId]);
    return result.rows[0] ?? null;
  }

  async recordFinalDecision(input: {
    caseId: string;
    analysisRunId: string;
    decision: "approved" | "rejected";
    actorId: string;
    rationale: string;
    idempotencyKey: string;
  }): Promise<JsonObject> {
    const result = await this.pool.query<JsonObject>(
      `SELECT id::text, case_id::text, analysis_run_id::text,
              decision, actor, rationale, decided_at
       FROM record_case_final_decision($1::uuid, $2::uuid, $3, $4, $5, $6)`,
      [input.caseId, input.analysisRunId, input.decision, input.actorId,
        input.rationale, input.idempotencyKey],
    );
    return result.rows[0]!;
  }

  async getEvidenceReadiness(caseId: string): Promise<JsonObject | null> {
    const selected = await this.pool.query<{ status: string; case_status: string }>(
      `SELECT case_evidence_readiness(id) AS status, status AS case_status
       FROM onboarding_cases WHERE id = $1::uuid`,
      [caseId],
    );
    if (!selected.rows[0]) return null;
    const [documents, jobs] = await Promise.all([
      this.pool.query<JsonObject>(
        `SELECT id::text, original_filename, checksum_sha256,
                ingestion_status, ingestion_error, created_at
         FROM case_documents WHERE case_id = $1::uuid ORDER BY created_at, id`,
        [caseId],
      ),
      this.pool.query<JsonObject>(
        `SELECT DISTINCT ON (COALESCE(evidence_checksum_sha256, idempotency_key))
                job_id, status, failure_summary, evidence_checksum_sha256 AS checksum_sha256,
                evidence_original_filename AS original_filename,
                evidence_document_type AS document_type, created_at
         FROM api_langflow_invocations
         WHERE case_id = $1::uuid AND purpose = 'evidence_ingestion'
         ORDER BY COALESCE(evidence_checksum_sha256, idempotency_key), created_at DESC, id DESC`,
        [caseId],
      ),
    ]);
    return {
      status: selected.rows[0].status,
      case_status: selected.rows[0].case_status,
      documents: documents.rows,
      jobs: jobs.rows,
    };
  }

  async reserveEvidenceInvocation(input: {
    caseId: string;
    checksumSha256: string;
    originalFilename: string;
    documentType: string;
    idempotencyKey: string;
    flowId: string;
    sessionId: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const selected = await client.query<{ status: string }>(
        `SELECT status FROM onboarding_cases WHERE id = $1::uuid FOR UPDATE`,
        [input.caseId],
      );
      if (!selected.rows[0]) throw new Error("case_not_found");
      if (!CASE_STATUSES_OPEN_FOR_ANALYSIS.includes(selected.rows[0].status)) {
        throw new Error("evidence_upload_unavailable");
      }
      await client.query(
        `INSERT INTO api_langflow_invocations (
           case_id, purpose, flow_id, job_id, session_id, status,
           idempotency_key, evidence_checksum_sha256,
           evidence_original_filename, evidence_document_type
         ) VALUES ($1::uuid, 'evidence_ingestion', $2, $3, $4, 'queued', $5, $6, $7, $8)`,
        [input.caseId, input.flowId, `pending:${input.idempotencyKey}`,
          input.sessionId, input.idempotencyKey, input.checksumSha256,
          input.originalFilename, input.documentType],
      );
    });
  }

  async finishEvidenceInvocation(idempotencyKey: string, jobId: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_langflow_invocations
       SET job_id = $2, status = $3, updated_at = clock_timestamp()
       WHERE idempotency_key = $1 AND purpose = 'evidence_ingestion'`,
      [idempotencyKey, jobId, status],
    );
  }

  async failEvidenceInvocation(idempotencyKey: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_langflow_invocations
       SET status = 'failed', updated_at = clock_timestamp()
       WHERE idempotency_key = $1 AND purpose = 'evidence_ingestion'`,
      [idempotencyKey],
    );
  }

  async startAnalysis(input: {
    caseId: string;
    sessionId: string;
    analystInstructions: string | null;
  }): Promise<AnalysisRunRecord> {
    return this.transaction(async (client) => {
      const selected = await client.query<{ archived_at: string | null }>(
        `SELECT archived_at FROM onboarding_cases WHERE id = $1::uuid FOR UPDATE`,
        [input.caseId],
      );
      if (selected.rows[0]?.archived_at) throw new Error("case_archived");
      const result = await client.query<AnalysisRunRecord>(
        `SELECT id::text, case_id::text, session_id, status, analyst_instructions,
                created_at
         FROM start_analysis_run($1::uuid, $2, $3, '1.1', CURRENT_DATE)`,
        [input.caseId, input.sessionId, input.analystInstructions],
      );
      return result.rows[0]!;
    });
  }

  async getRunIdentity(runId: string): Promise<(AnalysisRunRecord & {
    task_objective: string;
    coordinator_flow_id: string | null;
  }) | null> {
    const result = await this.pool.query<AnalysisRunRecord & {
      task_objective: string;
      coordinator_flow_id: string | null;
    }>(
      `SELECT r.id::text, r.case_id::text, r.session_id, r.status,
              r.analyst_instructions, r.created_at,
              original_invocation.flow_id AS coordinator_flow_id,
              COALESCE(coordinator.state->>'task_objective',
                'Perform a complete KYB analysis using the pinned case evidence and policies.') AS task_objective
       FROM analysis_runs r
       LEFT JOIN LATERAL (
         SELECT flow_id FROM api_langflow_invocations invocation
         WHERE invocation.analysis_run_id = r.id AND invocation.purpose = 'analysis_start'
         ORDER BY invocation.created_at, invocation.id LIMIT 1
       ) original_invocation ON true
       LEFT JOIN LATERAL (
         SELECT state FROM coordinator_v3_runs run
         WHERE run.analysis_run_id = r.id AND run.engine_version = 'durable-loop-v1'
         ORDER BY run.created_at DESC LIMIT 1
       ) coordinator ON true
       WHERE r.id = $1::uuid`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  async getPendingCheckpoint(runId: string, requestId: string): Promise<PendingCheckpoint | null> {
    const result = await this.pool.query<PendingCheckpoint>(
      `SELECT checkpoint.request_id, checkpoint.checkpoint_kind, checkpoint.expected_state_version,
              checkpoint.request_payload, skip.skipped_at
       FROM coordinator_v3_checkpoints checkpoint
       LEFT JOIN LATERAL (${LATEST_CHECKPOINT_SKIP_SQL}) skip ON true
       WHERE checkpoint.analysis_run_id = $1::uuid AND checkpoint.request_id = $2 AND checkpoint.status = 'pending'
       ORDER BY checkpoint.created_at DESC LIMIT 1`,
      [runId, requestId],
    );
    return result.rows[0] ?? null;
  }

  async hasAcceptedPolicyAssessment(runId: string): Promise<boolean> {
    const result = await this.pool.query<{ accepted: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM accepted_policy_assessments_for_run($1::uuid)) AS accepted`,
      [runId],
    );
    return result.rows[0]?.accepted === true;
  }

  async getRun(runId: string): Promise<JsonObject | null> {
    const runResult = await this.pool.query<JsonObject>(
      `SELECT r.id::text, r.case_id::text, r.session_id, r.status,
              r.analyst_instructions, r.started_at, r.finished_at, r.created_at,
              coordinator.id::text AS coordinator_run_id,
              coordinator.phase AS coordinator_phase,
              coordinator.current_iteration,
              coordinator.max_iterations,
              coordinator.state_version,
              coordinator.stop_reason,
              coordinator.state AS coordinator_state,
              invocation.flow_id AS latest_flow_id,
              invocation.job_id AS latest_job_id,
              invocation.status AS latest_job_status,
              invocation.failure_summary AS latest_job_failure_reason,
              invocation.purpose AS latest_job_purpose
       FROM analysis_runs r
       LEFT JOIN LATERAL (
         SELECT * FROM coordinator_v3_runs run
         WHERE run.analysis_run_id = r.id AND run.engine_version = 'durable-loop-v1'
         ORDER BY run.created_at DESC LIMIT 1
       ) coordinator ON true
       LEFT JOIN LATERAL (
         SELECT * FROM api_langflow_invocations item
         WHERE item.analysis_run_id = r.id ORDER BY item.created_at DESC LIMIT 1
       ) invocation ON true
       WHERE r.id = $1::uuid`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) return null;

    const [findings, gaps, conflicts, citations, rawContributions, runSources, taskEvents, coordinatorEvents, auditEvents, checkpoint, latestPlan, activityUpdates, analystAnswers, identityVerification] = await Promise.all([
      this.pool.query<JsonObject>(
        `SELECT id::text, requirement_code, outcome, summary, rationale,
                confidence::float8 AS confidence, created_at
         FROM findings WHERE analysis_run_id = $1::uuid ORDER BY created_at, id`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT id::text, requirement_code, description, requested_evidence, created_at
         FROM evidence_gaps WHERE analysis_run_id = $1::uuid ORDER BY created_at, id`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT id::text, subject, description, created_at
         FROM conflicts WHERE analysis_run_id = $1::uuid ORDER BY created_at, id`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT citation.id::text, citation.finding_id::text, citation.evidence_gap_id::text,
                citation.conflict_id::text, citation.source_kind, citation.locator,
                citation.excerpt, citation.created_at,
                CASE citation.source_kind
                  WHEN 'case_document' THEN citation.document_chunk_id::text
                  WHEN 'policy' THEN citation.policy_chunk_id::text
                  WHEN 'external_web' THEN citation.external_web_evidence_id::text
                  ELSE NULL END AS source_id,
                document.id::text AS document_id, document.original_filename,
                policy.code AS policy_code, policy.title AS policy_title,
                version.version AS policy_version,
                web.title AS web_title, web.publisher AS web_publisher,
                web.url AS web_url, web.retrieved_at AS web_retrieved_at,
                web.retrieval_method AS web_retrieval_method
         FROM citations citation
         LEFT JOIN document_chunks chunk ON chunk.id = citation.document_chunk_id
         LEFT JOIN case_documents document ON document.id = chunk.document_id
         LEFT JOIN policy_chunks policy_chunk ON policy_chunk.id = citation.policy_chunk_id
         LEFT JOIN policy_versions version ON version.id = policy_chunk.policy_version_id
         LEFT JOIN policy_documents policy ON policy.id = version.policy_document_id
         LEFT JOIN external_web_evidence web ON web.id = citation.external_web_evidence_id
         LEFT JOIN web_result_review_items reviewed
           ON reviewed.external_web_evidence_id = web.id AND reviewed.review_state = 'accepted'
         WHERE citation.analysis_run_id = $1::uuid
           AND (citation.source_kind <> 'external_web' OR reviewed.external_web_evidence_id IS NOT NULL)
         ORDER BY citation.created_at, citation.id`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT specialty, task_id, context_id, agent_name, agent_version,
                status, attempt, started_at, completed_at, payload
         FROM coordinator_v3_contributions WHERE analysis_run_id = $1::uuid
         ORDER BY completed_at, specialty`, [runId],
      ),
      this.pool.query<RunSource>(
        `SELECT 'case_document' AS source_kind, document.id::text AS source_id,
                document.document_type, document.original_filename, NULL AS policy_code
         FROM analysis_run_documents snapshot
         JOIN case_documents document ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
         WHERE snapshot.analysis_run_id = $1::uuid
         UNION ALL
         SELECT 'policy', version.id::text, NULL, NULL, policy.code
         FROM analysis_run_policy_versions snapshot
         JOIN policy_versions version ON version.id = snapshot.policy_version_id
         JOIN policy_documents policy ON policy.id = version.policy_document_id
         WHERE snapshot.analysis_run_id = $1::uuid`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT specialty, task_id, attempt, event_type, occurred_at, details
         FROM coordinator_v3_task_events WHERE analysis_run_id = $1::uuid
         ORDER BY occurred_at, id`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT event_type, iteration_no, payload, occurred_at
         FROM coordinator_v3_events WHERE analysis_run_id = $1::uuid
         ORDER BY cursor`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT event_type, actor_type, actor_id, payload, created_at
         FROM audit_events WHERE analysis_run_id = $1::uuid
         ORDER BY created_at, id`, [runId],
      ),
      this.pool.query<JsonObject>(
        `SELECT checkpoint.request_id, checkpoint.checkpoint_kind, checkpoint.expected_state_version,
                checkpoint.request_payload, checkpoint.created_at, checkpoint.expires_at, skip.skipped_at
         FROM coordinator_v3_checkpoints checkpoint
         LEFT JOIN LATERAL (${LATEST_CHECKPOINT_SKIP_SQL}) skip ON true
         WHERE checkpoint.analysis_run_id = $1::uuid AND checkpoint.status = 'pending'
         ORDER BY checkpoint.created_at DESC LIMIT 1`, [runId],
      ),
      typeof run.coordinator_run_id === "string"
        ? this.pool.query<JsonObject>(
          `SELECT directive->'plan' AS plan
           FROM coordinator_v3_iterations
           WHERE run_id = $1::uuid
           ORDER BY iteration_no DESC LIMIT 1`, [run.coordinator_run_id],
        )
        : Promise.resolve({ rows: [] as JsonObject[] }),
      typeof run.coordinator_run_id === "string"
        ? this.pool.query<JsonObject>(
          `SELECT subject_key, payload, iteration_no, created_at
           FROM coordinator_v3_activity_updates
           WHERE run_id = $1::uuid
           ORDER BY iteration_no, id`, [run.coordinator_run_id],
        )
        : Promise.resolve({ rows: [] as JsonObject[] }),
      this.pool.query<JsonObject>(
        `SELECT request.id::text AS human_input_request_id,
                request.response->>'question_id' AS question_id,
                request.response->>'specialty' AS specialty,
                request.response->>'field' AS field,
                request.response->>'subject' AS subject,
                request.question, request.response->>'answer' AS answer,
                request.submitted_by AS answered_by, request.responded_at AS answered_at
         FROM human_input_requests request
         WHERE request.analysis_run_id = $1::uuid AND request.status = 'answered'
           AND request.response->>'question_id' IS NOT NULL
         ORDER BY request.responded_at, request.correlation_id`, [runId],
      ),
      this.pool.query<{ verification: JsonObject | null }>(
        `SELECT coordinator_v3_identity_verification($1::uuid) AS verification`, [runId],
      ),
    ]);

    const sourceLabels = runSourceLabels(runSources.rows);
    const contributions = { rows: rawContributions.rows.map((row) => withCitationSourceLabels(row, sourceLabels)) };

    const reviewPath = buildReviewPath({
      plan: latestPlan.rows[0]?.plan,
      taskEvents: taskEvents.rows,
      contributions: contributions.rows,
      pendingCheckpoint: checkpoint.rows[0] ?? null,
      workflowFailed: run.latest_job_status === "failed"
        && run.stop_reason === "Langflow workflow execution failed",
    });

    return {
      ...run,
      findings: findings.rows,
      evidence_gaps: gaps.rows,
      conflicts: conflicts.rows,
      citations: citations.rows,
      agent_activity: {
        contributions: contributions.rows,
        task_events: taskEvents.rows,
        coordinator_events: coordinatorEvents.rows,
        tasks: buildAgentTasks({
          reviewPath,
          taskEvents: taskEvents.rows,
          pendingCheckpoint: checkpoint.rows[0] ?? null,
          coordinatorPhase: run.coordinator_phase,
          coordinatorState: run.coordinator_state,
          stopReason: run.stop_reason,
          workflowFailureReason: run.latest_job_status === "failed" ? run.latest_job_failure_reason : null,
          currentIteration: run.current_iteration,
          activityUpdates: activityUpdates.rows,
        }),
      },
      audit_events: auditEvents.rows,
      analyst_answers: analystAnswers.rows,
      identity_verification: identityVerification.rows[0]?.verification ?? null,
      pending_checkpoint: checkpoint.rows[0] ?? null,
      review_path: reviewPath,
      policy_comparisons: policyReview(contributions.rows),
    };
  }

  async recordInvocation(input: {
    caseId: string;
    analysisRunId?: string;
    evidenceSubmissionId?: string;
    purpose: LangflowInvocation["purpose"];
    flowId: string;
    jobId: string;
    sessionId: string;
    status: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_langflow_invocations (
         case_id, analysis_run_id, evidence_submission_id, purpose,
         flow_id, job_id, session_id, status, idempotency_key
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) DO UPDATE
       SET status = EXCLUDED.status, updated_at = clock_timestamp()`,
      [
        input.caseId,
        input.analysisRunId ?? null,
        input.evidenceSubmissionId ?? null,
        input.purpose,
        input.flowId,
        input.jobId,
        input.sessionId,
        input.status,
        input.idempotencyKey,
      ],
    );
  }

  async updateInvocationStatus(jobId: string, status: string, failureReason?: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE api_langflow_invocations
       SET status = $2, failure_summary = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END,
           updated_at = clock_timestamp()
       WHERE job_id = $1`,
      [jobId, status, status === "failed" ? failureReason ?? "Langflow workflow execution failed." : null],
    );
  }

  async recordCheckpointSkip(input: {
    runId: string;
    requestId: string;
    expectedStateVersion: number | string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.pool.query(
      `SELECT apply_simple_coordinator_v3_checkpoint_decision(
         p_analysis_run_id => $1::uuid, p_request_id => $2,
         p_expected_state_version => $3::bigint, p_action => 'skip_for_now',
         p_values => '{}'::jsonb, p_actor_id => $4, p_idempotency_key => $5)`,
      [input.runId, input.requestId, String(input.expectedStateVersion), input.actorId, input.idempotencyKey],
    );
  }

  async markExecutionFailed(runId: string, jobId: string): Promise<{ recovered: boolean }> {
    return this.transaction(async (client) => {
      const current = await client.query<{
        case_id: string;
        status: string;
        coordinator_run_id: string | null;
        coordinator_phase: string | null;
      }>(
        `SELECT r.case_id::text, r.status,
                coordinator.id::text AS coordinator_run_id,
                coordinator.phase AS coordinator_phase
         FROM analysis_runs r
         LEFT JOIN LATERAL (
           SELECT id, phase FROM coordinator_v3_runs
           WHERE analysis_run_id = r.id AND engine_version = 'durable-loop-v1'
           ORDER BY created_at DESC LIMIT 1
         ) coordinator ON true
         WHERE r.id = $1::uuid
         FOR UPDATE OF r`,
        [runId],
      );
      const run = current.rows[0];
      if (!run || !["queued", "running"].includes(run.status)) return { recovered: false };
      const latest = await client.query<{ job_id: string; status: string; failure_summary: string | null }>(
        `SELECT job_id, status, failure_summary FROM api_langflow_invocations
         WHERE analysis_run_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [runId],
      );
      if (latest.rows[0]?.job_id !== jobId
        || !TERMINAL_UNSUCCESSFUL_JOB_STATUSES.has(latest.rows[0]?.status)) return { recovered: false };
      if (run.coordinator_run_id) {
        if (run.coordinator_phase !== "running") return { recovered: false };
        // After findings exist, a failure returns the case to the handoff instead of
        // discarding the analysis; the caller resumes the coordinator to create it.
        const recovery = await client.query<{ outcome: { status: string } }>(
          `SELECT recover_coordinator_v3_after_failure($1::uuid, $2, $3) AS outcome`,
          [runId, jobId, latest.rows[0]?.failure_summary ?? null],
        );
        if (recovery.rows[0]?.outcome.status === "recovered") return { recovered: true };
        if (recovery.rows[0]?.outcome.status === "already_recovered") return { recovered: false };
        await client.query(
          `SELECT stop_simple_coordinator_v3($1::uuid, $2, $3)`,
          [run.coordinator_run_id, "Langflow workflow execution failed", `workflow-failed:${jobId}`],
        );
        return { recovered: false };
      }
      await client.query(
        `UPDATE analysis_runs SET status = 'failed', finished_at = clock_timestamp()
         WHERE id = $1::uuid`, [runId],
      );
      await client.query(
        `UPDATE onboarding_cases SET status = 'attention_required', updated_at = clock_timestamp()
         WHERE id = $1::uuid AND active_analysis_run_id = $2::uuid`,
        [run.case_id, runId],
      );
      await client.query(
        `INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, actor_id, payload)
         VALUES ($1::uuid, $2::uuid, 'workflow.execution_failed', 'system', 'api-bridge', $3::jsonb)`,
        [run.case_id, runId, JSON.stringify({ job_id: jobId })],
      );
      return { recovered: false };
    });
  }

  async markLaunchFailed(runId: string, message: string): Promise<void> {
    await this.transaction(async (client) => {
      const run = await client.query<{ case_id: string }>(
        `UPDATE analysis_runs SET status = 'failed', finished_at = clock_timestamp()
         WHERE id = $1::uuid AND status IN ('queued', 'running')
         RETURNING case_id::text`,
        [runId],
      );
      if (!run.rows[0]) return;
      await client.query(
        `UPDATE onboarding_cases SET status = 'attention_required', updated_at = clock_timestamp()
         WHERE id = $1::uuid`,
        [run.rows[0].case_id],
      );
      await client.query(
        `INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, actor_id, payload)
         VALUES ($1::uuid, $2::uuid, 'workflow.launch_failed', 'system', 'api-bridge', $3::jsonb)`,
        [run.rows[0].case_id, runId, JSON.stringify({ message })],
      );
    });
  }
}

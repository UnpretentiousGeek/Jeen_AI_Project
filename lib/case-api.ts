import type { DeclaredActivityField } from "@/src/case-catalog";


export type ApiCheckpoint = {
  request_id: string;
  checkpoint_kind: string;
  expected_state_version: number;
  request_payload: {
    title?: string;
    explanation?: string;
    allowed_actions?: string[];
    payload?: Record<string, unknown>;
  };
  created_at: string;
  expires_at?: string | null;
  skipped_at?: string | null;
};

export type ApiCitation = {
  id: string;
  finding_id: string | null;
  evidence_gap_id: string | null;
  conflict_id: string | null;
  source_kind: string;
  source_id: string | null;
  locator: string;
  excerpt: string;
  document_id: string | null;
  original_filename: string | null;
  policy_code: string | null;
  policy_title: string | null;
  policy_version: string | null;
  web_title: string | null;
  web_publisher: string | null;
  web_url: string | null;
  web_retrieved_at: string | null;
  web_retrieval_method: string | null;
};

export type ApiOpenableSourceKind = "case_document" | "policy" | "external_web";

type ApiSourceContentBase = {
  source_kind: ApiOpenableSourceKind;
  source_id: string;
  locator?: string | null;
};

export type ApiCaseDocumentSource = ApiSourceContentBase & {
  source_kind: "case_document";
  case_id: string;
  document_id: string;
  original_filename: string;
  document_type: string;
  mime_type: string;
  source_metadata: Record<string, unknown>;
  page_number: number | null;
  content: string;
  content_url?: string;
};

export type ApiPolicySource = ApiSourceContentBase & {
  source_kind: "policy";
  policy_code: string;
  policy_title: string;
  policy_version_id: string;
  version: string;
  effective_from: string | null;
  effective_to: string | null;
  content: string;
};

export type ApiExternalWebSource = ApiSourceContentBase & {
  source_kind: "external_web";
  url: string;
  canonical_url: string | null;
  title: string;
  publisher: string | null;
  published_at: string | null;
  retrieved_at: string;
  excerpt: string;
  content_hash: string;
  retrieval_method: string;
};

export type ApiSourceContent = ApiCaseDocumentSource | ApiPolicySource | ApiExternalWebSource;

export type ApiEvidenceGap = {
  id: string;
  requirement_code: string | null;
  description: string | null;
  requested_evidence: string | null;
  created_at: string;
};

export type ApiConflict = {
  id: string;
  subject: string | null;
  description: string | null;
  created_at: string;
};

export type ApiFinding = {
  id: string;
  requirement_code: string;
  outcome: "met" | "not_met" | "uncertain";
  summary: string;
  rationale: string;
  confidence: number | null;
  created_at: string;
};

export type ApiPolicyComparisonCitation = {
  id: string;
  source_kind: "case_document" | "policy";
  source_id: string;
  chunk_id: string;
  locator: string;
  excerpt: string;
};

export type ApiPolicyEvidenceReference = {
  evidence_type: string;
  reference: string;
  status: string;
  value: string;
  citation_id: string;
};

export type ApiPolicyComparisonException = {
  code: string;
  conditions: string;
  status: "satisfied" | "conflicting" | "unresolved";
  required_evidence: string[];
  available_evidence_references: ApiPolicyEvidenceReference[];
  unresolved_gaps: string[];
};

export type ApiPolicyComparisonRequirement = {
  requirement_code: string;
  description: string;
  applicability_rationale: string;
  required_evidence: string[];
  available_evidence_references: ApiPolicyEvidenceReference[];
  status: "supported" | "unsupported" | "conflicting";
  policy_citation_ids: string[];
  conditional_exceptions: ApiPolicyComparisonException[];
  escalation_conditions: Array<{ condition: string; triggered: boolean }>;
  unresolved_gaps: string[];
};

export type ApiPinnedPolicyVersion = {
  policy_version_id: string;
  policy_code: string;
  version: string;
  effective_from?: string | null;
  effective_to?: string | null;
};

export type ApiPolicyComparison = {
  status: "completed" | "partial";
  coverage_note: string | null;
  policy_effective_on: string | null;
  pinned_policy_versions: ApiPinnedPolicyVersion[];
  requirements: ApiPolicyComparisonRequirement[];
  citations: ApiPolicyComparisonCitation[];
};

export type ApiPolicyAssessment = {
  id: string;
  policy_chunk_id: string;
  document_id: string;
  review_state: "pending_review" | "accepted" | "rejected";
  review_rationale: string | null;
  proposal: {
    requirement: { statement: string; excerpt: string; required_evidence: string[] };
    facts: Array<{ chunk_id: string; fact: string; excerpt: string }>;
    outcome: "supports" | "contradicts" | "not_addressed" | "uncertain";
    rationale: string;
    /** Case-form answers that the cited facts (by position in facts) contradict. */
    declaration_conflicts: Array<{
      field: DeclaredActivityField;
      declared_value: string | string[];
      fact_indexes: number[];
      explanation: string;
    }>;
  };
};

export type ApiPolicyAssessmentCandidates = {
  policy_passages: Array<{ chunk_id: string; version_id: string; locator: string; content: string }>;
  documents: Array<{ document_id: string; document_type: string; original_filename: string; chunk_count: number }>;
};

export type ApiRun = {
  id: string;
  case_id: string;
  status: string;
  latest_job_failure_reason?: string | null;
  coordinator_state?: Record<string, unknown> | null;
  coordinator_phase: string | null;
  current_iteration: number | null;
  max_iterations: number | null;
  findings: ApiFinding[];
  evidence_gaps: ApiEvidenceGap[];
  conflicts: ApiConflict[];
  citations: ApiCitation[];
  policy_comparisons: ApiPolicyComparison | null;
  agent_activity: {
    contributions: Array<Record<string, unknown>>;
    task_events: Array<Record<string, unknown>>;
    coordinator_events: Array<Record<string, unknown>>;
    tasks: Array<{
      id: string;
      task_id: string | null;
      parent_task_id: string | null;
      role: "specialist" | "coordinator";
      specialty: string | null;
      label: string;
      status: "queued" | "working" | "waiting" | "input_required" | "completed" | "failed";
      attempt: number | null;
      dependency_ids: string[];
      current_summary: string | null;
      completed_summary: string | null;
      waiting_for: string | null;
      next_summary: string | null;
      failure_reason: string | null;
    }>;
  };
  review_path: {
    completed_steps: number;
    total_steps: number;
    steps: Array<{
      id: string;
      kind: "specialist" | "checkpoint";
      label: string;
      specialty: string | null;
      required: boolean;
      status: "planned" | "working" | "completed" | "failed" | "input_required";
      summary: string;
      result_summary: string | null;
      counts: Record<string, number>;
      waiting_on: string | null;
      next_action: string | null;
    }>;
  } | null;
  audit_events: Array<Record<string, unknown>>;
  analyst_answers: ApiAnalystAnswer[];
  identity_verification: ApiIdentityVerification | null;
  pending_checkpoint: ApiCheckpoint | null;
  polling: { active: boolean; interval_ms: number };
};

// Whether an official registry source has independently verified the registered identity.
// Uploaded documents are the applicant's own copies, so their agreement is consistency only.
export type ApiIdentityVerification = {
  requirement: "registered_identity";
  status: "verified" | "unverified";
  registries: Array<{ host: string; label: string }>;
  verified_by: Array<{ label: string; url?: string; external_web_evidence_id?: string; document_id?: string }>;
};

// An analyst's answer to one identity or ownership question, recorded as citable human input.
export type ApiAnalystAnswer = {
  human_input_request_id: string;
  question_id: string;
  specialty: "entity" | "ownership" | null;
  field: string | null;
  subject: string | null;
  question: string;
  answer: string;
  answered_by: string | null;
  answered_at: string;
};

export type ApiCaseSummary = {
  id: string;
  reference: string;
  status: string;
  created_at: string;
  updated_at: string;
  legal_name: string;
  jurisdiction: string;
  business_type: string;
  product: string;
  analysis_run_id: string | null;
  run_status: string | null;
  run_started_at: string | null;
  coordinator_phase: string | null;
  archived_at: string | null;
  pending_checkpoint_kind: string | null;
  pending_checkpoint_request_id: string | null;
  evidence_count: number;
  finding_count: number;
};

export type ApiDocument = {
  id: string;
  document_type: string;
  original_filename: string;
  mime_type: string;
  checksum_sha256: string;
  ingestion_status: string;
  ingestion_error: string | null;
  source_metadata: Record<string, unknown>;
  created_at: string;
};

export type ApiDeleteDocumentResult = {
  deleted: true;
  cleanup_warning?: string | null;
};

export type ApiDeleteCaseResult = {
  deleted: true;
  cleanup_warning?: string | null;
};

export type ApiCaseDetail = Omit<ApiCaseSummary, "analysis_run_id" | "run_status" | "run_started_at" | "coordinator_phase" | "pending_checkpoint_kind" | "pending_checkpoint_request_id" | "evidence_count" | "finding_count"> & {
  submitted_payload: Record<string, unknown>;
  active_analysis_run_id: string | null;
  documents: ApiDocument[];
  final_decision: ApiFinalDecision | null;
  run: ApiRun | null;
};

export type ApiFinalDecision = {
  id: string;
  case_id: string;
  analysis_run_id: string;
  decision: "approved" | "rejected";
  actor: string;
  rationale: string;
  decided_at: string;
};

export type ApiAssistantSource = {
  id: string;
  kind: "case" | "finding" | "evidence_gap" | "conflict" | "citation" | "case_document" | "policy" | "external_web";
  locator?: string;
  title?: string;
  url?: string;
};

export type ApiAssistantTurn = {
  id: string;
  case_id: string;
  actor_id: string;
  question: string;
  answer: string | null;
  analysis_run_id: string | null;
  source_refs: ApiAssistantSource[];
  status: "pending" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
  replayed?: boolean;
};

export type ApiAssistantConversation = {
  case_id: string;
  turns: ApiAssistantTurn[];
  next_before: string | null;
};

export type ApiEvidenceReadiness = {
  status: "empty" | "processing" | "failed" | "ready";
  case_status: string;
  can_start: boolean;
  poll_after_ms: number;
  documents: Array<Pick<ApiDocument, "id" | "original_filename" | "checksum_sha256" | "ingestion_status" | "ingestion_error" | "created_at">>;
  jobs: Array<{
    job_id: string;
    status: string;
    failure_summary: string | null;
    checksum_sha256: string | null;
    original_filename: string | null;
    document_type: string | null;
    created_at: string;
  }>;
};

export type ApiCaseTimelineEvent = {
  id: string;
  analysis_run_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  occurred_at: string;
  details: Record<string, unknown>;
};

export type ApiCaseTimeline = {
  events: ApiCaseTimelineEvent[];
  has_more: boolean;
  limit: number;
  offset: number;
};

export type CreateCaseRequest = {
  legal_name: string;
  jurisdiction: string;
  business_type: string;
  product: string;
  submitted_payload: Record<string, unknown>;
};

export type ApiProviderProfile = {
  legal_name: string;
  regulated_roles: Array<"bank" | "payment_institution" | "money_transmitter" | "marketplace">;
  service_jurisdictions: string[];
};

export type ApiPolicyRule = {
  id: string;
  code: string;
  statement: string;
  rule_kind: "operator_cdd" | "applicant_license" | "risk_guidance";
  policy_chunk_id: string;
  policy_version_id: string;
  section_locator: string;
  source_excerpt: string;
  source_path: string;
  applicability: "applies" | "does_not_apply" | "needs_information";
  reasons: string[];
};

type ApiErrorBody = {
  error?: { code?: string; message?: string };
};

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body instanceof FormData
      ? init.headers
      : { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(body.error?.message ?? "Unable to complete the request.");
  }
  return response.json() as Promise<T>;
}

export const caseApi = {
  async getProviderProfile(): Promise<ApiProviderProfile | null> {
    const response = await apiRequest<{ profile: ApiProviderProfile | null }>("/api/provider-profile");
    return response.profile;
  },

  async saveProviderProfile(profile: ApiProviderProfile): Promise<ApiProviderProfile> {
    const response = await apiRequest<{ profile: ApiProviderProfile }>("/api/provider-profile", {
      method: "PUT", body: JSON.stringify(profile),
    });
    return response.profile;
  },

  async getPolicyRules(runId: string): Promise<ApiPolicyRule[]> {
    const response = await apiRequest<{ rules: ApiPolicyRule[] }>(`/api/runs/${runId}/policy-rules`);
    return response.rules;
  },
  // The same run-pinned feed the API uses to allow a Policy Specialist retry.
  async listAcceptedPolicyAssessments(runId: string): Promise<ApiPolicyAssessment[]> {
    const response = await apiRequest<{ assessments: ApiPolicyAssessment[] }>(`/api/runs/${encodeURIComponent(runId)}/policy-assessments/accepted`);
    return response.assessments;
  },

  getPolicyAssessmentCandidates(runId: string): Promise<ApiPolicyAssessmentCandidates> {
    return apiRequest(`/api/runs/${encodeURIComponent(runId)}/policy-assessments/candidates`);
  },

  async listPolicyAssessments(runId: string): Promise<ApiPolicyAssessment[]> {
    const response = await apiRequest<{ assessments: ApiPolicyAssessment[] }>(`/api/runs/${encodeURIComponent(runId)}/policy-assessments`);
    return response.assessments;
  },

  generatePolicyAssessment(runId: string, policyChunkId: string, documentId: string): Promise<ApiPolicyAssessment> {
    return apiRequest(`/api/runs/${encodeURIComponent(runId)}/policy-assessments`, {
      method: "POST",
      body: JSON.stringify({ policy_chunk_id: policyChunkId, document_id: documentId }),
    });
  },

  reviewPolicyAssessment(runId: string, proposalId: string, decision: "accepted" | "rejected", rationale: string): Promise<ApiPolicyAssessment> {
    return apiRequest(`/api/runs/${encodeURIComponent(runId)}/policy-assessments/${encodeURIComponent(proposalId)}/review`, {
      method: "POST",
      headers: { "x-actor-id": "local-analyst" },
      body: JSON.stringify({ decision, rationale }),
    });
  },
  async list(): Promise<ApiCaseSummary[]> {
    const response = await apiRequest<{ cases: ApiCaseSummary[] }>("/api/cases");
    return response.cases;
  },

  get(caseId: string): Promise<ApiCaseDetail> {
    return apiRequest(`/api/cases/${caseId}`);
  },

  getRun(runId: string, signal?: AbortSignal): Promise<ApiRun> {
    return apiRequest(`/api/runs/${encodeURIComponent(runId)}`, { signal });
  },

  getSource(runId: string, sourceKind: ApiOpenableSourceKind, sourceId: string): Promise<ApiSourceContent> {
    return apiRequest(`/api/runs/${encodeURIComponent(runId)}/sources/${sourceKind}/${encodeURIComponent(sourceId)}`);
  },

  setArchived(caseId: string, archived: boolean): Promise<{ id: string; archived_at: string | null }> {
    return apiRequest(`/api/cases/${caseId}/archive`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
      headers: { "x-actor-id": "local-analyst" },
    });
  },

  deleteCase(caseId: string): Promise<ApiDeleteCaseResult> {
    return apiRequest(`/api/cases/${caseId}`, { method: "DELETE" });
  },

  getEvidenceReadiness(caseId: string): Promise<ApiEvidenceReadiness> {
    return apiRequest(`/api/cases/${caseId}/evidence/status`);
  },

  getCaseTimeline(caseId: string, limit = 50, offset = 0, signal?: AbortSignal): Promise<ApiCaseTimeline> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return apiRequest(`/api/cases/${caseId}/timeline?${params.toString()}`, { signal });
  },

  getAssistantTurns(caseId: string, before?: string, limit = 20): Promise<ApiAssistantConversation> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    return apiRequest(`/api/cases/${caseId}/assistant/turns?${params.toString()}`);
  },

  askAssistant(caseId: string, input: { question: string; idempotency_key: string }): Promise<ApiAssistantTurn> {
    return apiRequest(`/api/cases/${caseId}/assistant/turns`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "x-actor-id": "local-analyst" },
    });
  },

  create(input: CreateCaseRequest): Promise<ApiCaseDetail> {
    return apiRequest("/api/cases", { method: "POST", body: JSON.stringify(input) });
  },

  uploadEvidence(caseId: string, files: File[], documentType = "supporting_document"): Promise<unknown> {
    const form = new FormData();
    form.set("document_type", documentType);
    files.forEach((file) => form.append("files", file));
    return apiRequest(`/api/cases/${caseId}/evidence`, {
      method: "POST",
      body: form,
      headers: { "x-actor-id": "local-analyst" },
    });
  },

  documentContentUrl(caseId: string, documentId: string): string {
    return `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/content`;
  },

  deleteDocument(caseId: string, documentId: string): Promise<ApiDeleteDocumentResult> {
    return apiRequest(`/api/cases/${caseId}/documents/${documentId}`, {
      method: "DELETE",
    });
  },

  startAnalysis(caseId: string): Promise<{ id: string; poll_after_ms: number }> {
    return apiRequest(`/api/cases/${caseId}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  recordFinalDecision(caseId: string, input: {
    analysis_run_id: string;
    decision: "approved" | "rejected";
    actor_id: string;
    rationale: string;
    idempotency_key: string;
  }): Promise<ApiFinalDecision> {
    return apiRequest(`/api/cases/${caseId}/decision`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  submitCheckpoint(runId: string, input: {
    request_id: string;
    action_id: string;
    values: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<unknown> {
    return apiRequest(`/api/runs/${runId}/responses`, {
      method: "POST",
      body: JSON.stringify({
        ...input,
        actor_id: "local-analyst",
      }),
    });
  },
};

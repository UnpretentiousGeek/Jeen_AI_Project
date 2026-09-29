import { describe, expect, it } from "vitest";

import {
  parseSpecialistResultEnvelopeV3,
  specialistResultEnvelopeV3Schema,
  specialistTaskInputV3Schema,
  specialistTaskResumeInputV3Schema,
  validateSpecialistResultEnvelopeV3,
  validateSpecialistTaskResumeV3,
} from "../src/a2a/task-contract.js";

const ids = {
  case: "20000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  coordinator: "20000000-0000-4000-8000-000000000003",
  document: "20000000-0000-4000-8000-000000000004",
  policy: "20000000-0000-4000-8000-000000000005",
  web: "20000000-0000-4000-8000-000000000006",
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "3.0",
    case_id: ids.case,
    analysis_run_id: ids.run,
    coordinator_run_id: ids.coordinator,
    task_id: "entity-task-1",
    context_id: "entity-context-1",
    specialty: "entity",
    task_objective: "Reconcile the applicant legal identity.",
    attempt: 1,
    parent_task_id: null,
    evidence_scope: {
      permitted_document_ids: [ids.document],
      permitted_policy_version_ids: [ids.policy],
      permitted_web_result_ids: [],
    },
    allow_network: false,
    ...overrides,
  };
}

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "3.0",
    analysis_run_id: ids.run,
    coordinator_run_id: ids.coordinator,
    task_id: "entity-task-1",
    context_id: "entity-context-1",
    attempt: 1,
    parent_task_id: null,
    result_type: "specialist_contribution",
    specialty: "entity",
    payload: {
      record_ref: "artifact-entity-1",
      record_hash: "sha256:entity-hash",
      citation_refs: [{ id: "doc-citation-1", source_kind: "case_document" }],
    },
    ...overrides,
  };
}

describe("strict v3 specialist task contracts", () => {
  it("accepts a bounded dispatch and rejects unknown root/nested fields", () => {
    expect(specialistTaskInputV3Schema.safeParse(task()).success).toBe(true);
    expect(specialistTaskInputV3Schema.safeParse(task({ unexpected: true })).success).toBe(false);
    expect(specialistTaskInputV3Schema.safeParse(task({
      evidence_scope: { ...task().evidence_scope, extra: true },
    })).success).toBe(false);
  });

  it("requires UUID run identity and forbids network or out-of-scope web IDs", () => {
    expect(specialistTaskInputV3Schema.safeParse(task({ analysis_run_id: "run-1" })).success).toBe(false);
    expect(specialistTaskInputV3Schema.safeParse(task({ allow_network: true })).success).toBe(false);
    expect(specialistTaskInputV3Schema.safeParse(task({
      evidence_scope: { ...task().evidence_scope, permitted_web_result_ids: [ids.web] },
    })).success).toBe(false);
    expect(specialistTaskInputV3Schema.safeParse(task({
      specialty: "public_research",
      evidence_scope: { ...task().evidence_scope, permitted_web_result_ids: [ids.web] },
    })).success).toBe(true);
  });

  it("enforces retry lineage and allows the public-research scope only as explicit IDs", () => {
    expect(specialistTaskInputV3Schema.safeParse(task({ attempt: 1, parent_task_id: "parent-1" })).success).toBe(false);
    expect(specialistTaskInputV3Schema.safeParse(task({ attempt: 2, parent_task_id: null })).success).toBe(false);
    expect(specialistTaskInputV3Schema.safeParse(task({ attempt: 2, parent_task_id: "entity-task-0" })).success).toBe(true);
    expect(specialistTaskInputV3Schema.safeParse(task({
      specialty: "public_research",
      evidence_scope: { ...task().evidence_scope, permitted_web_result_ids: [ids.web] },
    })).success).toBe(true);
  });

  it("correlates resume responses and preserves the immutable task context", () => {
    const resume = {
      ...task(),
      outstanding_request: { request_id: "request-1", response_type: "text" },
      response: {
        request_id: "request-1",
        response_type: "text",
        values: { text: "The registered address is unchanged." },
        responder: "analyst-1",
        responded_at: "2026-09-20T12:00:00Z",
      },
    };
    expect(specialistTaskResumeInputV3Schema.safeParse(resume).success).toBe(true);
    expect(specialistTaskResumeInputV3Schema.safeParse({
      ...resume,
      response: { ...resume.response, request_id: "request-2" },
    }).success).toBe(false);
    expect(validateSpecialistTaskResumeV3(resume, task())).toEqual(resume);
    expect(() => validateSpecialistTaskResumeV3({ ...resume, task_objective: "altered" }, task())).toThrow(
      "immutable task field task_objective",
    );
  });

  it("rejects cross-run and cross-context result envelopes", () => {
    expect(parseSpecialistResultEnvelopeV3(contribution())).toEqual(contribution());
    expect(() => validateSpecialistResultEnvelopeV3({ ...contribution(), analysis_run_id: ids.coordinator }, task()))
      .toThrow("analysis_run_id");
    expect(() => validateSpecialistResultEnvelopeV3({ ...contribution(), context_id: "other-context" }, task()))
      .toThrow("context_id");
  });

  it("requires accepted public-research IDs for external-web citations and never permits network", () => {
    const publicTask = task({
      specialty: "public_research",
      evidence_scope: { ...task().evidence_scope, permitted_web_result_ids: [ids.web] },
    });
    const publicResult = contribution({
      specialty: "public_research",
      payload: {
        record_ref: "artifact-public-1",
        record_hash: "sha256:public-hash",
        citation_refs: [{ id: "web-citation-1", source_kind: "external_web", web_result_id: ids.web }],
      },
    });
    expect(validateSpecialistResultEnvelopeV3(publicResult, publicTask)).toEqual(publicResult);
    expect(() => validateSpecialistResultEnvelopeV3({
      ...publicResult,
      payload: {
        ...publicResult.payload,
        citation_refs: [{ id: "web-citation-1", source_kind: "external_web", web_result_id: ids.document }],
      },
    }, publicTask)).toThrow("outside the permitted web-result scope");
    expect(specialistResultEnvelopeV3Schema.safeParse({
      ...contribution(),
      payload: {
        ...contribution().payload,
        citation_refs: [{ id: "web-citation-1", source_kind: "external_web", web_result_id: ids.web }],
      },
    }).success).toBe(false);
  });

  it("accepts the other strict result variants and rejects unknown payload fields", () => {
    const { specialty: _specialty, ...nonContributionBase } = contribution();
    for (const result of [
      {
        ...nonContributionBase,
        result_type: "human_input_request",
        payload: { request_id: "request-1", response_type: "text", prompt: "Provide evidence." },
      },
      {
        ...nonContributionBase,
        result_type: "research_request",
        payload: { request_id: "research-1", query: "official register" },
      },
      {
        ...nonContributionBase,
        result_type: "failure",
        payload: { code: "specialist_timeout", message: "The specialist timed out.", retryable: true },
      },
    ]) {
      expect(specialistResultEnvelopeV3Schema.safeParse(result).success).toBe(true);
    }
    expect(specialistResultEnvelopeV3Schema.safeParse({
      ...contribution(),
      payload: { ...contribution().payload, extra: true },
    }).success).toBe(false);
  });
});

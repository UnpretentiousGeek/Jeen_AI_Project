import { describe, expect, it, vi } from "vitest";

import { createApiHandler } from "../src/api/http.ts";
import type { CaseApiService } from "../src/api/service.ts";
import {
  declaredAnswers,
  selectEvidence,
  validateAssessmentProposal,
  type AssessmentContext,
  type AssessmentProposal,
} from "../src/policy/assessment.ts";
import type { AssessmentRepository } from "../src/policy/assessment-repository.ts";
import { PolicyAssessmentService } from "../src/policy/assessment-service.ts";
import { assessmentTier, rankAssessments } from "../src/policy/assessment-ranking.ts";
import type { PolicyAssessmentExtractor } from "../src/policy/openai-extractor.ts";

const runId = "b0000000-0000-4000-8000-000000000001";
const caseId = "b0000000-0000-4000-8000-000000000002";
const policyChunkId = "b0000000-0000-4000-8000-000000000003";
const documentId = "b0000000-0000-4000-8000-000000000004";
const documentChunkId = "b0000000-0000-4000-8000-000000000005";
const proposalId = "b0000000-0000-4000-8000-000000000006";

const context: AssessmentContext = {
  analysis_run_id: runId,
  case_id: caseId,
  policy: {
    chunk_id: policyChunkId,
    version_id: "b0000000-0000-4000-8000-000000000007",
    locator: "KYB-1.1",
    content: "The applicant's legal name must be supported by current incorporation evidence.",
  },
  document: {
    id: documentId,
    original_filename: "certificate.pdf",
    chunks: [{
      id: documentChunkId,
      locator: "Page 1",
      content: "Certificate of Incorporation. Legal name: Acme Holdings Ltd. Registered on 4 May 2026.",
    }],
  },
};

const proposal: AssessmentProposal = {
  requirement: {
    statement: "The legal name needs current incorporation evidence.",
    excerpt: "legal name must be supported by current incorporation evidence",
    required_evidence: ["current incorporation evidence"],
  },
  facts: [{
    chunk_id: documentChunkId,
    fact: "The certificate names Acme Holdings Ltd.",
    excerpt: "Legal name: Acme Holdings Ltd",
  }],
  outcome: "supports",
  rationale: "The certificate states the legal name, subject to analyst review of currency and identity.",
  declaration_conflicts: [],
};

describe("dynamic policy assessment", () => {
  it("accepts cited facts from ordinary document text without demo markers", () => {
    expect(validateAssessmentProposal(context, proposal)).toEqual(proposal);
  });

  it("rejects invented policy or document quotations and foreign chunks", () => {
    expect(() => validateAssessmentProposal(context, {
      ...proposal,
      requirement: { ...proposal.requirement, excerpt: "A license is required in New York" },
    })).toThrow("invalid_requirement");
    expect(() => validateAssessmentProposal(context, {
      ...proposal,
      facts: [{ ...proposal.facts[0]!, excerpt: "Legal name: Other Company" }],
    })).toThrow("invalid_fact_citation");
    expect(() => validateAssessmentProposal(context, {
      ...proposal,
      facts: [{ ...proposal.facts[0]!, chunk_id: "b0000000-0000-4000-8000-000000000099" }],
    })).toThrow("invalid_fact_citation");
    expect(() => validateAssessmentProposal(context, {
      ...proposal, facts: [],
    })).toThrow("missing_facts");
  });

  it("accepts quotes whose only difference is whitespace and stores the source's own text", () => {
    const tableContext: AssessmentContext = {
      ...context,
      document: { ...context.document, chunks: [{
        id: documentChunkId, locator: "Page 1",
        content: "| Legal name        | Acme Holdings Ltd   |\n| Company number    | 01234567            |",
      }] },
    };
    const validated = validateAssessmentProposal(tableContext, {
      ...proposal,
      requirement: { ...proposal.requirement, excerpt: "legal name must be\nsupported by current incorporation evidence" },
      facts: [{ ...proposal.facts[0]!, excerpt: "| Legal name | Acme Holdings Ltd |" }],
    });
    expect(validated.requirement.excerpt).toBe("legal name must be supported by current incorporation evidence");
    expect(validated.facts[0]!.excerpt).toBe("| Legal name        | Acme Holdings Ltd   |");
    // Different words are still rejected.
    expect(() => validateAssessmentProposal(tableContext, {
      ...proposal, facts: [{ ...proposal.facts[0]!, excerpt: "| Legal name | Acme Group Ltd |" }],
    })).toThrow("invalid_fact_citation");
  });

  it("flags declared answers that cited facts contradict, taking the declared answer from the case", () => {
    const fundsContext: AssessmentContext = {
      ...context,
      declaration: declaredAnswers({
        payment_activity: "facilitates", handles_customer_funds: "no",
        licensing_basis: "unknown", operating_jurisdictions: [],
      }),
      document: { ...context.document, chunks: [{
        id: documentChunkId, locator: "Note 14",
        content: "Seller money is held in a designated client bank account in the Company's name.",
      }] },
    };
    expect(fundsContext.declaration).toEqual({ payment_activity: "facilitates", handles_customer_funds: "no" });
    const candidate = {
      ...proposal,
      outcome: "uncertain",
      facts: [{
        chunk_id: documentChunkId,
        fact: "The Company holds seller money in its own client account.",
        excerpt: "held in a designated client bank account in the Company's name",
      }],
      declaration_conflicts: [{
        field: "handles_customer_funds", fact_indexes: [0],
        explanation: "The report says the Company holds seller money; the applicant declared it does not.",
        declared_value: "yes",
      }],
    };
    expect(validateAssessmentProposal(fundsContext, candidate).declaration_conflicts).toEqual([{
      field: "handles_customer_funds", declared_value: "no", fact_indexes: [0],
      explanation: "The report says the Company holds seller money; the applicant declared it does not.",
    }]);
    const conflict = candidate.declaration_conflicts[0]!;
    // Unanswered questions, uncited facts, repeats and empty explanations are rejected.
    expect(() => validateAssessmentProposal(fundsContext, {
      ...candidate, declaration_conflicts: [{ ...conflict, field: "licensing_basis" }],
    })).toThrow("undeclared_conflict");
    expect(() => validateAssessmentProposal(context, candidate)).toThrow("invalid_fact_citation");
    for (const bad of [
      [{ ...conflict, fact_indexes: [1] }],
      [{ ...conflict, fact_indexes: [] }],
      [{ ...conflict, fact_indexes: [0, 0] }],
      [{ ...conflict, fact_indexes: [0.5] }],
      [{ ...conflict, explanation: " " }],
      [conflict, conflict],
    ]) {
      expect(() => validateAssessmentProposal(fundsContext, { ...candidate, declaration_conflicts: bad }))
        .toThrow("invalid_conflict");
    }
    // A conflict still rests on a verified quote.
    expect(() => validateAssessmentProposal(fundsContext, {
      ...candidate, facts: [{ ...candidate.facts[0]!, excerpt: "held in a trust account" }],
    })).toThrow("invalid_fact_citation");
  });

  it("ranks declaration conflicts, then decisive, then uncertain, then uninformative proposals", () => {
    const item = (id: string, outcome: AssessmentProposal["outcome"], facts: number, conflicts = 0) => ({
      id,
      proposal: {
        ...proposal, outcome,
        facts: Array.from({ length: facts }, () => proposal.facts[0]!),
        declaration_conflicts: Array.from({ length: conflicts }, () => ({
          field: "handles_customer_funds" as const, declared_value: "no", fact_indexes: [0], explanation: "x",
        })),
      },
    });
    const ranked = rankAssessments([
      item("not-addressed", "not_addressed", 1),
      item("uncertain-empty", "uncertain", 0),
      item("uncertain-2", "uncertain", 2),
      item("uncertain-4", "uncertain", 4),
      item("supports", "supports", 1),
      item("contradicts", "contradicts", 1),
      item("conflict", "uncertain", 1, 1),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual([
      "conflict", "contradicts", "supports", "uncertain-4", "uncertain-2", "not-addressed", "uncertain-empty",
    ]);
    // Proposals stored before conflicts were reported still rank.
    const { declaration_conflicts: _omitted, ...legacy } = proposal;
    expect(assessmentTier({ proposal: legacy })).toBe("decisive");
  });

  it("lists proposals most informative first", async () => {
    const stored = (id: string, outcome: AssessmentProposal["outcome"], conflicts: number) => ({
      id, proposal: { ...proposal, outcome, declaration_conflicts: Array.from({ length: conflicts }, () => ({
        field: "handles_customer_funds" as const, declared_value: "no", fact_indexes: [0], explanation: "x",
      })) },
    });
    const repository = {
      list: vi.fn().mockResolvedValue([stored("a", "not_addressed", 0), stored("b", "uncertain", 0), stored("c", "uncertain", 1)]),
    } as unknown as AssessmentRepository;
    const { assessments } = await new PolicyAssessmentService(repository, null).list(runId);
    expect(assessments.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("permits an explicitly unaddressed requirement without inventing evidence", () => {
    expect(validateAssessmentProposal(context, {
      ...proposal, facts: [], outcome: "not_addressed",
    }).outcome).toBe("not_addressed");
  });

  it("stores only verified proposals and keeps them pending analyst review", async () => {
    const save = vi.fn().mockImplementation(async (input) => ({
      id: proposalId,
      ...input,
      review_state: "pending_review",
    }));
    const repository = {
      listCandidates: vi.fn(),
      getContext: vi.fn().mockResolvedValue(context),
      save,
      list: vi.fn().mockResolvedValue([]),
      listAccepted: vi.fn().mockResolvedValue([]),
      review: vi.fn(),
    } as unknown as AssessmentRepository;
    const extractor = {
      model: "test-model",
      extract: vi.fn().mockResolvedValue(proposal),
    } as PolicyAssessmentExtractor;
    const service = new PolicyAssessmentService(repository, extractor);

    await expect(service.generate(runId, {
      policy_chunk_id: policyChunkId, document_id: documentId,
    })).resolves.toMatchObject({ id: proposalId, review_state: "pending_review" });
    expect(repository.getContext).toHaveBeenCalledWith(runId, policyChunkId, documentId);
    expect(save).toHaveBeenCalledWith({ context, model: "test-model", proposal });

    const badExtractor = {
      model: "test-model",
      extract: vi.fn().mockResolvedValue({
        ...proposal, facts: [{ ...proposal.facts[0]!, excerpt: "Fabricated evidence" }],
      }),
    };
    await expect(new PolicyAssessmentService(repository, badExtractor).generate(runId, {
      policy_chunk_id: policyChunkId, document_id: documentId,
    })).rejects.toMatchObject({ code: "policy_assessment_invalid" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("sends a whole document that fits the budget, and otherwise its most relevant chunks in order", () => {
    const chunk = (id: string, length: number, relevance: number | null) =>
      ({ id, locator: id, content: "x".repeat(length), relevance });
    const small = [chunk("a", 10, 0.1), chunk("b", 10, null)];
    expect(selectEvidence(small, 100)).toEqual({
      chunks: small.map(({ id, locator, content }) => ({ id, locator, content })),
    });
    const large = [chunk("a", 40, 0.2), chunk("b", 40, 0.9), chunk("c", 40, null), chunk("d", 40, 0.5)];
    const selected = selectEvidence(large, 100);
    // The two most similar chunks fit; they keep the document's order.
    expect(selected.chunks.map((item) => item.id)).toEqual(["b", "d"]);
    expect(selected.selection).toEqual({ method: "most_relevant", supplied_chunks: 2, total_chunks: 4 });
  });

  it("assesses every remaining passage and document pair and reports failures without stopping", async () => {
    const otherPolicy = "b0000000-0000-4000-8000-000000000010";
    const otherDocument = "b0000000-0000-4000-8000-000000000011";
    const repository = {
      listCandidates: vi.fn().mockResolvedValue({
        policy_passages: [
          { chunk_id: policyChunkId, version_id: "v", locator: "KYB-1.1", content: "" },
          { chunk_id: otherPolicy, version_id: "v", locator: "KYB-1.2", content: "" },
        ],
        documents: [
          { document_id: documentId, document_type: "formation_certificate", original_filename: "certificate.pdf", chunk_count: 1 },
          { document_id: otherDocument, document_type: "supporting_document", original_filename: "declaration.pdf", chunk_count: 1 },
        ],
      }),
      // One pair was proposed before an interruption; it is not assessed again.
      list: vi.fn().mockResolvedValue([{ policy_chunk_id: policyChunkId, document_id: documentId }]),
      listAccepted: vi.fn().mockResolvedValue([]),
      getContext: vi.fn().mockImplementation(async (_run, policy, document) =>
        (policy === otherPolicy && document === otherDocument ? null : context)),
      save: vi.fn().mockImplementation(async () => ({ id: proposalId, proposal })),
      review: vi.fn(),
    } as unknown as AssessmentRepository;
    const extractor = { model: "test-model", extract: vi.fn().mockResolvedValue(proposal) } as PolicyAssessmentExtractor;
    const result = await new PolicyAssessmentService(repository, extractor).generateAll(runId);
    expect(result).toMatchObject({ pair_count: 4, skipped_existing: 1, not_attempted: 0 });
    expect(result.assessed).toHaveLength(2);
    expect(result.assessed[0]).toMatchObject({ proposal_id: proposalId, outcome: "supports" });
    expect(result.failed).toEqual([expect.objectContaining({
      policy_chunk_id: otherPolicy, document_id: otherDocument, error: "policy_assessment_scope",
    })]);
  });

  it("gives the model one corrected attempt after a misquote and stores only the verified answer", async () => {
    const save = vi.fn().mockImplementation(async (input) => ({ id: proposalId, ...input }));
    const repository = {
      getContext: vi.fn().mockResolvedValue(context), save,
    } as unknown as AssessmentRepository;
    const extract = vi.fn()
      .mockResolvedValueOnce({ ...proposal, facts: [{ ...proposal.facts[0]!, excerpt: "Legal name: Other Company" }] })
      .mockResolvedValueOnce(proposal);
    await new PolicyAssessmentService(repository, { model: "test-model", extract }).generate(runId, {
      policy_chunk_id: policyChunkId, document_id: documentId,
    });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1]![1]).toContain("copied exactly from the document chunk");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].proposal).toEqual(proposal);
  });

  it("exposes generation, listing, and review through scoped run routes", async () => {
    const generate = vi.fn().mockResolvedValue({ id: proposalId, review_state: "pending_review" });
    const list = vi.fn().mockResolvedValue({ assessments: [] });
    const listCandidates = vi.fn().mockResolvedValue({ policy_passages: [], documents: [] });
    const listAccepted = vi.fn().mockResolvedValue({ assessments: [] });
    const review = vi.fn().mockResolvedValue({ id: proposalId, review_state: "accepted" });
    const generateAll = vi.fn().mockResolvedValue({ assessed: [], failed: [] });
    const handle = createApiHandler({
      service: {} as CaseApiService,
      policyAssessments: { generate, generateAll, list, listCandidates, listAccepted, review } as unknown as PolicyAssessmentService,
      storageRoot: "/tmp",
    });
    const base = `http://localhost/api/runs/${runId}/policy-assessments`;
    const created = await handle(new Request(base, {
      method: "POST",
      body: JSON.stringify({ policy_chunk_id: policyChunkId, document_id: documentId }),
    }));
    expect(created.status).toBe(201);
    expect(generate).toHaveBeenCalledWith(runId, {
      policy_chunk_id: policyChunkId, document_id: documentId,
    });
    expect((await handle(new Request(`${base}/batch`, { method: "POST" }))).status).toBe(200);
    expect(generateAll).toHaveBeenCalledWith(runId);
    expect((await handle(new Request(base))).status).toBe(200);
    expect(list).toHaveBeenCalledWith(runId);
    expect((await handle(new Request(`${base}/candidates`))).status).toBe(200);
    expect(listCandidates).toHaveBeenCalledWith(runId);
    expect((await handle(new Request(`${base}/accepted`))).status).toBe(200);
    expect(listAccepted).toHaveBeenCalledWith(runId);
    const reviewed = await handle(new Request(`${base}/${proposalId}/review`, {
      method: "POST",
      headers: { "x-actor-id": "analyst-1" },
      body: JSON.stringify({ decision: "accepted", rationale: "Verified against the certificate." }),
    }));
    expect(reviewed.status).toBe(200);
    expect(review).toHaveBeenCalledWith(runId, proposalId, "analyst-1", {
      decision: "accepted", rationale: "Verified against the certificate.",
    });
  });
});

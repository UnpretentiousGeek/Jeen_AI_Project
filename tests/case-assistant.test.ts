import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { OpenAICaseAssistantAgent } from "../src/api/assistant-agent.js";
import type { CohereRetrievalClient } from "../src/api/cohere-retrieval.js";
import type {
  AssistantCaseContext,
  AssistantRepository,
  AssistantTurn,
} from "../src/api/assistant-repository.js";
import { CaseAssistantService } from "../src/api/assistant-service.js";
import { createApiHandler } from "../src/api/http.js";
import type { CaseApiService } from "../src/api/service.js";

const caseId = "32000000-0000-4000-8000-000000000051";
const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";
const context: AssistantCaseContext = {
  case_id: caseId,
  reference: "KYB-TEST",
  status: "ready_for_review",
  case_created_at: "2026-09-20T10:00:00Z",
  case_updated_at: "2026-09-23T10:00:00Z",
  status_changed_at: null,
  legal_name: "Example Ltd",
  jurisdiction: "GB",
  business_type: "Software",
  product: "Payments",
  entity_declaration: null,
  analysis_run_id: runId,
  analysis_run_status: "succeeded",
  analysis_run_started_at: "2026-09-22T10:01:00Z",
  analysis_run_finished_at: "2026-09-23T10:00:00Z",
  pending_checkpoint_kind: null,
  final_decision: null,
};
const pending: AssistantTurn = {
  id: "32000000-0000-4000-8000-000000000052",
  case_id: caseId,
  actor_id: "analyst-1",
  question: "What evidence supports the address?",
  answer: null,
  analysis_run_id: null,
  source_refs: [],
  status: "pending",
  claim_token: "32000000-0000-4000-8000-000000000053",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
  completed_at: null,
};

describe("case assistant backend", () => {
  it("persists a sourced answer and exposes it through the case route", async () => {
    const source = { id: "chunk-1", kind: "case_document" as const, locator: "page 2" };
    const completed = {
      ...pending, status: "completed" as const, answer: "The address appears on page 2.",
      analysis_run_id: runId, source_refs: [source], completed_at: "2026-09-23T00:00:01Z",
    };
    const repository = {
      getCaseContext: vi.fn().mockResolvedValue(context),
      claimTurn: vi.fn().mockResolvedValue({ state: "claimed", turn: pending }),
      listTurns: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([completed]),
      completeTurn: vi.fn().mockResolvedValue(completed),
      failTurn: vi.fn(),
    } as unknown as AssistantRepository;
    const agent = { answer: vi.fn().mockResolvedValue({
      answer: completed.answer, sourceRefs: [source],
    }) };
    const assistant = new CaseAssistantService(repository, agent);
    const handle = createApiHandler({
      service: {} as CaseApiService, assistant, storageRoot: "/tmp",
    });
    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/assistant/turns`, {
      method: "POST",
      headers: { "x-actor-id": "analyst-1" },
      body: JSON.stringify({ question: pending.question, idempotency_key: "question-1" }),
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      answer: completed.answer, analysis_run_id: runId, source_refs: [source], replayed: false,
    });
    expect(repository.completeTurn).toHaveBeenCalledWith({
      turnId: pending.id, claimToken: pending.claim_token,
      answer: completed.answer, analysisRunId: runId, sourceRefs: [source],
    });

    const history = await handle(new Request(`http://localhost/api/cases/${caseId}/assistant/turns`));
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({ turns: [{ answer: completed.answer }] });
  });

  it("replays a completed request without calling the model", async () => {
    const completed = { ...pending, status: "completed" as const, answer: "Recorded answer." };
    const repository = {
      getCaseContext: vi.fn().mockResolvedValue(context),
      claimTurn: vi.fn().mockResolvedValue({ state: "completed", turn: completed }),
    } as unknown as AssistantRepository;
    const agent = { answer: vi.fn() };
    const result = await new CaseAssistantService(repository, agent).ask(
      caseId, "analyst-1", { question: pending.question, idempotency_key: "question-1" },
    );
    expect(result.replayed).toBe(true);
    expect(agent.answer).not.toHaveBeenCalled();
  });

  it("paginates a shared case conversation from the oldest returned turn", async () => {
    const turns = [1, 2, 3].map((number) => ({
      ...pending,
      id: `32000000-0000-4000-8000-00000000005${number}`,
      status: "completed" as const,
      answer: `Answer ${number}`,
    }));
    const repository = {
      getCaseContext: vi.fn().mockResolvedValue(context),
      listTurns: vi.fn().mockResolvedValue(turns),
    } as unknown as AssistantRepository;
    const conversation = await new CaseAssistantService(repository, null)
      .getConversation(caseId, { limit: "2" });

    expect(conversation.turns.map((turn) => turn.answer)).toEqual(["Answer 2", "Answer 3"]);
    expect(conversation.next_before).toBe(turns[1]?.id);
    expect(repository.listTurns).toHaveBeenCalledWith(caseId, 3, undefined);
  });

  it("returns a service error when the model is not configured", async () => {
    const repository = { getCaseContext: vi.fn() } as unknown as AssistantRepository;
    const service = new CaseAssistantService(repository, null);
    await expect(service.ask(caseId, "analyst-1", {
      question: "What is the status?", idempotency_key: "question-1",
    })).rejects.toMatchObject({ status: 503, code: "assistant_unavailable" });
    expect(repository.getCaseContext).not.toHaveBeenCalled();
  });

  it("limits model tools and accepted source IDs to the selected run", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "call-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: "registered address" }), call_id: "call-2",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The registered address is on page 2.",
        source_ids: ["chunk-1", "another-case-chunk"],
      }) });
    const repository = {
      searchCaseEvidence: vi.fn().mockResolvedValue([{
        source_id: "document-1", chunk_id: "chunk-1", locator: "page 2",
        excerpt: "Registered address: 1 Market Street", original_filename: "registration.pdf",
      }]),
    } as unknown as AssistantRepository;
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model", repository,
    );

    const result = await agent.answer({ context, history: [], question: pending.question });

    expect(result).toEqual({
      answer: "The registered address is on page 2.",
      sourceRefs: [{ id: "chunk-1", kind: "case_document", locator: "page 2", title: "registration.pdf" }],
    });
    expect(repository.searchCaseEvidence).toHaveBeenCalledWith(runId, "registered address");
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      store: false, tool_choice: { type: "function", name: "get_case_overview" },
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ tool_choice: "auto" });
  });

  it("embeds and reranks case evidence before exposing only selected citations", async () => {
    const candidates = [
      { chunk_id: "chunk-1", locator: "page 1", excerpt: "Company registration number", original_filename: "registration.pdf" },
      { chunk_id: "chunk-2", locator: "page 2", excerpt: "Registered address: 1 Market Street", original_filename: "registration.pdf" },
      { chunk_id: "chunk-3", locator: "page 3", excerpt: "Director date of birth", original_filename: "registration.pdf" },
    ];
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: "registered address" }), call_id: "search-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The registered address is on page 2.",
        source_ids: ["chunk-2", "chunk-3"],
      }) });
    const repository = {
      searchCaseEvidence: vi.fn().mockResolvedValue(candidates),
      listUnembeddedChunks: vi.fn().mockResolvedValue([]),
    } as unknown as AssistantRepository;
    const cohere = {
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]),
      rerank: vi.fn().mockResolvedValue([1, 0]),
    } as unknown as CohereRetrievalClient;
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI,
      "test-model",
      repository,
      cohere,
    );

    const result = await agent.answer({ context, history: [], question: "Where is the address?" });

    expect(cohere.embedQuery).toHaveBeenCalledExactlyOnceWith("registered address");
    expect(repository.searchCaseEvidence).toHaveBeenCalledExactlyOnceWith(
      runId, "registered address", [0.1, 0.2],
    );
    expect(cohere.rerank).toHaveBeenCalledExactlyOnceWith(
      "registered address", candidates.map((row) => row.excerpt), 5,
    );
    const searchOutput = create.mock.calls[2]?.[0].input.find((item: { type?: string; call_id?: string }) =>
      item.type === "function_call_output" && item.call_id === "search-1");
    expect(JSON.parse(searchOutput.output)).toEqual([candidates[1], candidates[0]]);
    expect(result).toEqual({
      answer: "The registered address is on page 2.",
      sourceRefs: [{
        id: "chunk-2", kind: "case_document", locator: "page 2", title: "registration.pdf",
      }],
    });
  });

  it("falls back to run-scoped lexical search when query embedding fails", async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      chunk_id: `chunk-${index + 1}`,
      locator: `page ${index + 1}`,
      excerpt: `Evidence passage ${index + 1}`,
      original_filename: "registration.pdf",
    }));
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-embed-fallback",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: "registered address" }), call_id: "search-embed-fallback",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The first passage supports the address.", source_ids: ["chunk-1", "out-of-run-chunk"],
      }) });
    const repository = {
      searchCaseEvidence: vi.fn().mockResolvedValue(candidates),
      listUnembeddedChunks: vi.fn().mockResolvedValue([]),
    } as unknown as AssistantRepository;
    const cohere = {
      embedQuery: vi.fn().mockRejectedValue(new Error("private Cohere response body")),
      rerank: vi.fn().mockResolvedValue([0]),
    } as unknown as CohereRetrievalClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI,
      "test-model",
      repository,
      cohere,
    );

    const result = await agent.answer({ context, history: [], question: "Where is the address?" });

    expect(repository.searchCaseEvidence).toHaveBeenCalledExactlyOnceWith(runId, "registered address");
    expect(cohere.rerank).toHaveBeenCalledExactlyOnceWith(
      "registered address", candidates.map((row) => row.excerpt), 5,
    );
    const searchOutput = create.mock.calls[2]?.[0].input.find((item: { type?: string; call_id?: string }) =>
      item.type === "function_call_output" && item.call_id === "search-embed-fallback");
    const rows = JSON.parse(searchOutput.output);
    expect(rows).toEqual([candidates[0]]);
    expect(rows).toHaveLength(1);
    expect(searchOutput.output).not.toContain("private Cohere response body");
    expect(result.sourceRefs).toEqual([{
      id: "chunk-1", kind: "case_document", locator: "page 1", title: "registration.pdf",
    }]);
    expect(warn).toHaveBeenCalledWith("Cohere query embedding failed; using lexical assistant evidence search.");
    warn.mockRestore();
  });

  it("returns lexical-first candidates when reranking fails", async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      chunk_id: `chunk-${index + 1}`,
      locator: `page ${index + 1}`,
      excerpt: `Lexical passage ${index + 1}`,
      original_filename: "registration.pdf",
    }));
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-rerank-fallback",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: "registered address" }), call_id: "search-rerank-fallback",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The first passage supports the address.", source_ids: ["chunk-1", "out-of-run-chunk"],
      }) });
    const repository = {
      searchCaseEvidence: vi.fn().mockResolvedValue(candidates),
      listUnembeddedChunks: vi.fn().mockResolvedValue([]),
    } as unknown as AssistantRepository;
    const cohere = {
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]),
      rerank: vi.fn().mockRejectedValue(new Error("private Cohere response body")),
    } as unknown as CohereRetrievalClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI,
      "test-model",
      repository,
      cohere,
    );

    const result = await agent.answer({ context, history: [], question: "Where is the address?" });

    expect(repository.searchCaseEvidence).toHaveBeenCalledExactlyOnceWith(
      runId, "registered address", [0.1, 0.2],
    );
    const searchOutput = create.mock.calls[2]?.[0].input.find((item: { type?: string; call_id?: string }) =>
      item.type === "function_call_output" && item.call_id === "search-rerank-fallback");
    expect(JSON.parse(searchOutput.output)).toEqual(candidates.slice(0, 5));
    expect(searchOutput.output).not.toContain("private Cohere response body");
    expect(result.sourceRefs).toEqual([{
      id: "chunk-1", kind: "case_document", locator: "page 1", title: "registration.pdf",
    }]);
    expect(warn).toHaveBeenCalledWith("Cohere reranking failed; using lexical-first assistant evidence results.");
    warn.mockRestore();
  });

  it("reranks accepted web evidence without embedding the lexical query", async () => {
    const candidates = [
      { id: "web-1", excerpt: "General company directory listing", title: "Directory", url: "https://example.test/directory" },
      { id: "web-2", excerpt: "Regulator record confirms the company address", title: "Regulator", url: "https://example.test/record" },
    ];
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_accepted_web_evidence",
        arguments: JSON.stringify({ query: "company address" }), call_id: "search-web-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The regulator record confirms the address.", source_ids: ["web-2", "web-1"],
      }) });
    const repository = {
      searchAcceptedWebEvidence: vi.fn().mockResolvedValue(candidates),
    } as unknown as AssistantRepository;
    const cohere = {
      embedQuery: vi.fn(),
      rerank: vi.fn().mockResolvedValue([1]),
    } as unknown as CohereRetrievalClient;
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI,
      "test-model",
      repository,
      cohere,
    );

    const result = await agent.answer({ context, history: [], question: "Is the company address confirmed?" });

    expect(cohere.embedQuery).not.toHaveBeenCalled();
    expect(repository.searchAcceptedWebEvidence).toHaveBeenCalledExactlyOnceWith(runId, "company address");
    expect(cohere.rerank).toHaveBeenCalledExactlyOnceWith(
      "company address", candidates.map((row) => row.excerpt), 5,
    );
    const searchOutput = create.mock.calls[2]?.[0].input.find((item: { type?: string; call_id?: string }) =>
      item.type === "function_call_output" && item.call_id === "search-web-1");
    expect(JSON.parse(searchOutput.output)).toEqual([candidates[1]]);
    expect(result.sourceRefs).toEqual([{
      id: "web-2", kind: "external_web", title: "Regulator", url: "https://example.test/record",
    }]);
  });

  it("guides status answers to report known progress without conflating run finish and case completion", async () => {
    const statusContext: AssistantCaseContext = {
      ...context,
      status: "awaiting_approval",
      case_created_at: "2026-09-20T10:00:00Z",
      case_updated_at: "2026-09-23T10:00:00Z",
      status_changed_at: "2026-09-22T10:00:00Z",
      analysis_run_status: "suspended",
      analysis_run_started_at: "2026-09-22T10:01:00Z",
      analysis_run_finished_at: null,
      pending_checkpoint_kind: "analyst_approval",
      final_decision: null,
    };
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The active analysis is waiting for analyst approval.", source_ids: [caseId],
      }) });
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model", {} as AssistantRepository,
    );

    await agent.answer({
      context: statusContext, history: [], question: "What is the case status and progress?",
    });

    const initialRequest = create.mock.calls[0]?.[0];
    const instructions = initialRequest?.instructions as string;
    const overviewTool = (initialRequest?.tools as Array<{ name: string; description: string }>)
      .find((tool) => tool.name === "get_case_overview");
    expect(overviewTool?.description).toContain("active analysis run progress");
    expect(instructions).toMatch(/case_updated_at only as the case record's\s+last update/);
    expect(instructions).toMatch(/finished_at means only\s+that the run finished/);
    expect(instructions).toMatch(/include\s+its outcome, decided_at, and rationale/);
    expect(instructions).toMatch(/final_decision\.decided_at is the\s+authoritative human decision and completion time/);
    expect(instructions).toMatch(/historical cases may have no recorded transition/);
    expect(instructions).toMatch(/pending checkpoint is present, mention its kind/);
    expect(instructions).toContain("approval or review checkpoints indicate pending human review");
    expect(instructions).toMatch(/Never infer\s+missing timestamps/);
    expect(create.mock.calls[1]?.[0].input).toContainEqual(expect.objectContaining({
      type: "function_call_output",
      call_id: "overview-1",
      output: JSON.stringify({ citation_id: caseId, case: statusContext }),
    }));
  });

  it.each([
    ["missing citation", JSON.stringify({ answer: "This case is completed.", source_ids: [] })],
    ["malformed output", "{ answer: "],
  ])("recovers a status answer after overview and citation repair (%s)", async (_label, firstAnswer) => {
    const completedContext = {
      ...context,
      reference: "KYB-COORD-V3-51",
      status: "completed",
      analysis_run_status: "succeeded",
    };
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: firstAnswer })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "KYB-COORD-V3-51 is completed.", source_ids: [caseId],
      }) });
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model",
      {} as AssistantRepository,
    );

    const result = await agent.answer({
      context: completedContext, history: [], question: "What is the current status?",
    });

    expect(result).toEqual({
      answer: "KYB-COORD-V3-51 is completed.",
      sourceRefs: [{ id: caseId, kind: "case", title: "KYB-COORD-V3-51" }],
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "get_case_overview" },
      parallel_tool_calls: false,
    });
    expect(create.mock.calls[1]?.[0].input).toContainEqual(expect.objectContaining({
      type: "function_call_output",
      call_id: "overview-1",
      output: JSON.stringify({ citation_id: caseId, case: completedContext }),
    }));
    expect(create.mock.calls[2]?.[0]).toMatchObject({ tool_choice: "none" });
    expect(create.mock.calls[2]?.[0].input).toContainEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining(caseId),
    }));
  });

  it.each([
    { label: "blank", query: "" },
    { label: "over 500 characters", query: "x".repeat(501) },
  ])("recovers from an invalid generated search query ($label)", async ({ query: invalidQuery }) => {
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: invalidQuery }), call_id: "invalid-search-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: "registered address" }), call_id: "valid-search-1",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "The registered address is on page 2.", source_ids: ["chunk-1"],
      }) });
    const repository = {
      searchCaseEvidence: vi.fn().mockResolvedValue([{
        chunk_id: "chunk-1", locator: "page 2", original_filename: "registration.pdf",
      }]),
    } as unknown as AssistantRepository;
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model", repository,
    );

    const result = await agent.answer({ context, history: [], question: "Where is the address?" });

    expect(result.answer).toBe("The registered address is on page 2.");
    expect(repository.searchCaseEvidence).toHaveBeenCalledExactlyOnceWith(runId, "registered address");
    expect(create.mock.calls[2]?.[0].input).toContainEqual(expect.objectContaining({
      type: "function_call_output",
      call_id: "invalid-search-1",
      output: JSON.stringify({
        error: "invalid_query", message: "Provide a non-empty search query of at most 500 characters.",
      }),
    }));
  });

  it("embeds the run's unembedded chunks once before the first semantic search", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-embed",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [
        { type: "function_call", name: "search_case_evidence",
          arguments: JSON.stringify({ query: "registered address" }), call_id: "search-embed-1" },
        { type: "function_call", name: "search_policy_evidence",
          arguments: JSON.stringify({ query: "address policy" }), call_id: "search-embed-2" },
      ], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "No address evidence was found.", source_ids: [caseId],
      }) });
    const repository = {
      listUnembeddedChunks: vi.fn().mockResolvedValue([
        { id: "chunk-new", kind: "document", content: "Registered address: 1 Market Street" },
        { id: "policy-new", kind: "policy", content: "Verify the registered address." },
      ]),
      storeEmbeddings: vi.fn().mockResolvedValue(undefined),
      searchCaseEvidence: vi.fn().mockResolvedValue([]),
      searchPolicyEvidence: vi.fn().mockResolvedValue([]),
    } as unknown as AssistantRepository;
    const cohere = {
      embedDocuments: vi.fn().mockResolvedValue([[0.3], [0.4]]),
      embedQuery: vi.fn().mockResolvedValue([0.1]),
      rerank: vi.fn().mockResolvedValue([]),
    } as unknown as CohereRetrievalClient;
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model", repository, cohere,
    );

    await agent.answer({ context, history: [], question: "Where is the address?" });

    expect(repository.listUnembeddedChunks).toHaveBeenCalledExactlyOnceWith(runId, 192);
    expect(cohere.embedDocuments).toHaveBeenCalledExactlyOnceWith([
      "Registered address: 1 Market Street", "Verify the registered address.",
    ]);
    expect(repository.storeEmbeddings).toHaveBeenCalledExactlyOnceWith([
      { id: "chunk-new", kind: "document", embedding: [0.3] },
      { id: "policy-new", kind: "policy", embedding: [0.4] },
    ]);
    expect(repository.searchCaseEvidence).toHaveBeenCalledWith(runId, "registered address", [0.1]);
  });

  it("keeps searching when chunk embedding fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-embed-fail",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "search_case_evidence",
        arguments: JSON.stringify({ query: "registered address" }), call_id: "search-embed-fail",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "No address evidence was found.", source_ids: [caseId],
      }) });
    const repository = {
      listUnembeddedChunks: vi.fn().mockResolvedValue([{ id: "chunk-new", kind: "document", content: "text" }]),
      storeEmbeddings: vi.fn(),
      searchCaseEvidence: vi.fn().mockResolvedValue([]),
    } as unknown as AssistantRepository;
    const cohere = {
      embedDocuments: vi.fn().mockRejectedValue(new Error("private Cohere response body")),
      embedQuery: vi.fn().mockResolvedValue([0.1]),
      rerank: vi.fn().mockResolvedValue([]),
    } as unknown as CohereRetrievalClient;
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model", repository, cohere,
    );

    const result = await agent.answer({ context, history: [], question: "Where is the address?" });

    expect(result.answer).toBe("No address evidence was found.");
    expect(repository.storeEmbeddings).not.toHaveBeenCalled();
    expect(repository.searchCaseEvidence).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Cohere chunk embedding failed; assistant evidence search may be lexical only.");
    warn.mockRestore();
  });

  it("reports a retry of an in-flight question as in progress, not busy", async () => {
    const repository = {
      getCaseContext: vi.fn().mockResolvedValue(context),
      claimTurn: vi.fn().mockResolvedValue({ state: "in_progress" }),
    } as unknown as AssistantRepository;
    const agent = { answer: vi.fn() };
    await expect(new CaseAssistantService(repository, agent).ask(
      caseId, "analyst-1", { question: pending.question, idempotency_key: "question-1" },
    )).rejects.toMatchObject({ status: 409, code: "assistant_in_progress" });
    expect(agent.answer).not.toHaveBeenCalled();
  });

  it("answers small talk briefly without forcing case citations", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_case_overview", arguments: "{}", call_id: "overview-greeting",
      }], output_text: "" })
      .mockResolvedValueOnce({ output: [], output_text: JSON.stringify({
        answer: "Hi! Ask me anything about this case.", answer_type: "conversational", source_ids: [caseId],
      }) });
    const agent = new OpenAICaseAssistantAgent(
      { responses: { create } } as unknown as OpenAI, "test-model", {} as AssistantRepository,
    );

    const result = await agent.answer({ context, history: [], question: "hey" });

    expect(result).toEqual({ answer: "Hi! Ask me anything about this case.", sourceRefs: [] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].instructions).toContain('"conversational"');
  });
});

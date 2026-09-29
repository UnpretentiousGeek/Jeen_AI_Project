import { describe, expect, it } from "vitest";

import { createApiHandler } from "../src/api/http.js";
import type { CaseApiService } from "../src/api/service.js";
import { LangflowWorkflowClient } from "../src/workflow/langflow-client.js";

describe("Langflow v2 Workflow API client", () => {
  it("keeps Langflow's reason when it refuses a request, and the API shows it", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ detail: "Flow not found" }, { status: 404 }),
    });
    const refused = await client.startBackground({ flowId: "flow-1", inputValue: "{}", sessionId: "s" })
      .catch((error: unknown) => error);
    const handle = createApiHandler({
      service: { getRun: async () => { throw refused; } } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });
    const response = await handle(new Request("http://localhost/api/runs/b0000000-0000-4000-8000-000000000001"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe('Langflow refused the request (HTTP 404): {"detail":"Flow not found"}');
  });

  it("reports an unreachable Langflow as workflow_unavailable, which the API explains", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => { throw new TypeError("fetch failed"); },
    });
    await expect(client.startBackground({ flowId: "flow-1", inputValue: "{}", sessionId: "s" }))
      .rejects.toThrow("workflow_unavailable");

    const handle = createApiHandler({
      service: { getRun: async () => { throw new Error("workflow_unavailable"); } } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });
    const response = await handle(new Request("http://localhost/api/runs/b0000000-0000-4000-8000-000000000001"));
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain("Langflow is not responding");
  });

  it("uploads a file to Langflow and returns its managed path", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async (resource, init) => {
        request = { url: String(resource), init };
        return Response.json({ file_path: "flow-1/uploaded.pdf" }, { status: 201 });
      },
    });

    await expect(client.uploadFile({
      flowId: "flow-1",
      storagePath: "package.json",
      filename: "uploaded.pdf",
      mimeType: "application/pdf",
    })).resolves.toBe("flow-1/uploaded.pdf");
    expect(request?.url).toBe("http://localhost:7860/api/v1/files/upload/flow-1");
    expect(request?.init?.headers).toEqual({ "x-api-key": "test-key" });
    expect(request?.init?.body).toBeInstanceOf(FormData);
    expect((request?.init?.body as FormData).get("file")).toMatchObject({ name: "uploaded.pdf" });
  });

  it("deletes a managed file using Langflow's file endpoint without a JSON content type", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async (resource, init) => {
        request = { url: String(resource), init };
        return new Response(null, { status: 204 });
      },
    });

    await expect(client.deleteFile({
      flowId: "flow-1",
      storagePath: "/Users/tester/.langflow/cache/flow-1/uploaded report.pdf",
    })).resolves.toBeUndefined();
    expect(request?.url).toBe(
      "http://localhost:7860/api/v1/files/delete/flow-1/uploaded%20report.pdf",
    );
    expect(request?.init?.method).toBe("DELETE");
    expect(request?.init?.headers).toEqual({ "x-api-key": "test-key" });
    expect(request?.init?.body).toBeUndefined();
  });

  it("treats a missing managed file as already deleted", async () => {
    let requests = 0;
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 404 });
      },
    });

    await expect(client.deleteFile({
      flowId: "flow-1",
      storagePath: "/Users/tester/.langflow/cache/flow-1/already-gone.pdf",
    })).resolves.toBeUndefined();
    expect(requests).toBe(1);
  });

  it("rejects paths that do not identify a simple file in the requested flow cache", async () => {
    let requests = 0;
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => {
        requests += 1;
        return Response.json({});
      },
    });
    const invalidInputs = [
      { flowId: "flow-1", storagePath: "/Users/tester/uploads/uploaded.pdf" },
      { flowId: "flow-1", storagePath: "/Users/tester/.langflow/cache/other-flow/uploaded.pdf" },
      { flowId: "flow-1", storagePath: "/Users/tester/.langflow/cache/flow-1/subdir/uploaded.pdf" },
      { flowId: "flow-1", storagePath: "/Users/tester/.langflow/cache/flow-1/../other-flow/uploaded.pdf" },
      { flowId: "flow-1/nested", storagePath: "/Users/tester/.langflow/cache/flow-1/nested/uploaded.pdf" },
    ];

    for (const input of invalidInputs) {
      await expect(client.deleteFile(input)).rejects.toThrow("Langflow");
    }
    expect(requests).toBe(0);
  });

  it("does not expose Langflow response text when deletion fails", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => new Response("secret diagnostic", { status: 500 }),
    });

    await expect(client.deleteFile({
      flowId: "flow-1",
      storagePath: "/Users/tester/.langflow/cache/flow-1/uploaded.pdf",
    })).rejects.toThrow("Langflow file deletion failed with HTTP 500");
    await expect(client.deleteFile({
      flowId: "flow-1",
      storagePath: "/Users/tester/.langflow/cache/flow-1/uploaded.pdf",
    })).rejects.not.toThrow("secret diagnostic");
  });

  it("starts HITL-capable flows in background mode", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860/",
      apiKey: "test-key",
      fetchImpl: async (resource, init) => {
        request = { url: String(resource), init };
        return Response.json({
          flow_id: "flow-interrupted",
          job_id: "job-interrupted",
          object: "job",
          status: "queued",
          links: {
            status: "/api/v2/workflows?job_id=job-interrupted",
            events: "/api/v2/workflows/job-interrupted/events",
            stop: "/api/v2/workflows/stop",
          },
        });
      },
    });

    const result = await client.startBackground({
      flowId: "flow-interrupted",
      inputValue: "Analyze the interrupted case.",
      sessionId: "case-run-interrupted",
      idempotencyKey: "case-run-interrupted",
    });

    expect(result.job_id).toBe("job-interrupted");
    expect(request?.url).toBe("http://localhost:7860/api/v2/workflows");
    expect(request?.init?.headers).toMatchObject({ "x-api-key": "test-key" });
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      flow_id: "flow-interrupted",
      mode: "background",
      session_id: "case-run-interrupted",
      idempotency_key: "case-run-interrupted",
    });
  });

  it("parses native pending Human Input checkpoints", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json([{
        job_id: "job-interrupted",
        flow_id: "flow-interrupted",
        session_id: "case-run-interrupted",
        request_id: "HumanInput-abc:job-interrupted",
        kind: "node_input",
        prompt: "Who owns the remaining 18%?",
        options: [{ action_id: "clarification_recorded", label: "Clarification recorded" }],
        allowed_decisions: ["clarification_recorded"],
      }]),
    });

    await expect(client.pending("flow-interrupted")).resolves.toEqual([
      expect.objectContaining({
        job_id: "job-interrupted",
        request_id: "HumanInput-abc:job-interrupted",
        allowed_decisions: ["clarification_recorded"],
      }),
    ]);
  });

  it("resumes the exact pending request through its stable action id", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async (resource, init) => {
        request = { url: String(resource), init };
        return Response.json({
          job_id: "job-interrupted",
          message: "Workflow resumed",
          status: "in_progress",
        });
      },
    });

    await client.resume({
      jobId: "job-interrupted",
      requestId: "langflow-human-request",
      actionId: "clarification_recorded",
    });

    expect(request?.url).toBe(
      "http://localhost:7860/api/v2/workflows/job-interrupted/resume",
    );
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      request_id: "langflow-human-request",
      decision: { action_id: "clarification_recorded" },
    });
  });

  it("does not leak a server error body through client exceptions", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => new Response("secret diagnostic", { status: 500 }),
    });

    await expect(client.status("failed-job")).rejects.toThrow("HTTP 500");
    await expect(client.status("failed-job")).rejects.not.toThrow("secret diagnostic");
  });

  it("recognizes Langflow's JOB_FAILED response as a failed job", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ detail: {
        code: "JOB_FAILED",
        job_id: "failed-job",
        error_detail: { data: {
          flow_id: "coordinator-flow",
          text: "tool policy specialist response returned invalid JSON: Policy contribution content differs from the deterministically retrieved matrix",
        } },
      } }, { status: 500 }),
    });

    await expect(client.status("failed-job")).resolves.toMatchObject({
      flow_id: "coordinator-flow", job_id: "failed-job", status: "failed",
      failure_reason: "Policy specialist output did not match the retrieved policy matrix.",
    });
  });

  it.each([
    [
      "tool save_final_findings_v3 response returned invalid JSON: (psycopg2.errors.InsufficientPrivilege) citation references case evidence outside the analysis run\n",
      "Coordinator cited evidence that is outside this analysis run.",
    ],
    [
      "Supervisor could not produce a valid bounded decision: final citations are out of scope: findings[0]",
      "Coordinator cited evidence that is outside this analysis run.",
    ],
    [
      "tool save_final_findings_v3 response failed: (psycopg2.errors.ObjectNotInPrerequisiteState) coordinator run cannot accept final findings\n",
      "Database rejected a workflow update: coordinator run cannot accept final findings.",
    ],
    [
      "tool save_final_findings_v3 response failed: (psycopg2.errors.RaiseException) analysis run 1ed597df is not the failed active run",
      "Langflow tool save_final_findings_v3 failed.",
    ],
    [
      "tool save_final_findings_v3 response failed: secret token abc123",
      "Langflow tool save_final_findings_v3 failed.",
    ],
  ])("summarizes coordinator failure %#", async (text, failureReason) => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ detail: {
        code: "JOB_FAILED", job_id: "failed-job",
        error_detail: { data: { flow_id: "coordinator-flow", text } },
      } }, { status: 500 }),
    });
    const status = await client.status("failed-job");
    expect(status.failure_reason).toBe(failureReason);
    expect(status.failure_reason).not.toMatch(/abc123|1ed597df/);
  });

  it("does not expose unexpected Langflow error text", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ detail: {
        code: "JOB_FAILED", job_id: "failed-job",
        error_detail: { data: { flow_id: "coordinator-flow", text: "secret token abc123" } },
      } }, { status: 500 }),
    });
    await expect(client.status("failed-job")).resolves.toMatchObject({
      failure_reason: "Langflow workflow execution failed.",
    });
  });

  it("explains a missing EasyOCR dependency without exposing the raw Langflow error", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ detail: {
        code: "JOB_FAILED", job_id: "failed-job",
        error_detail: { data: { flow_id: "ingestion-flow", text: "Docling conversion error: EasyOCR is not installed. Local path: /private/example.pdf" } },
      } }, { status: 500 }),
    });

    await expect(client.status("failed-job")).resolves.toMatchObject({
      failure_reason: "Langflow's document reader needs EasyOCR, or OCR must be disabled for text-based files.",
    });
  });

  it("identifies the policy validation stage when Langflow hides the nested error", async () => {
    const client = new LangflowWorkflowClient({
      serverUrl: "http://localhost:7860",
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ detail: {
        code: "JOB_FAILED", job_id: "failed-job",
        error_detail: { data: {
          flow_id: "coordinator-flow",
          text: "tool run_policy_agent response returned invalid JSON: Error running graph: Error building Component Validate Policy Contribution: \n",
        } },
      } }, { status: 500 }),
    });
    await expect(client.status("failed-job")).resolves.toMatchObject({
      failure_reason: "Policy specialist output could not be validated.",
    });
  });
});

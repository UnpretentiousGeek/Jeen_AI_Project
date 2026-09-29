import { describe, expect, it } from "vitest";

import {
  COHERE_EMBED_MODEL,
  COHERE_RERANK_MODEL,
  CohereRetrievalClient,
} from "../src/api/cohere-retrieval.js";

const vector = (value = 0): number[] => Array.from({ length: 1024 }, () => value);

describe("Cohere retrieval client", () => {
  it("embeds a query with search_query and validates a 1024-value vector", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new CohereRetrievalClient("test-cohere-key", async (url, init) => {
      request = { url: String(url), init };
      return Response.json({ embeddings: { float: [vector(0.25)] } });
    });

    await expect(client.embedQuery("query text")).resolves.toEqual(vector(0.25));
    expect(request?.url).toBe("https://api.cohere.com/v2/embed");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.headers).toEqual({
      authorization: "Bearer test-cohere-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: COHERE_EMBED_MODEL,
      input_type: "search_query",
      texts: ["query text"],
      embedding_types: ["float"],
    });
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("embeds documents in batches of at most 96 using search_document", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new CohereRetrievalClient("test-key", async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      const texts = body.texts as string[];
      return Response.json({ embeddings: { float: texts.map((_, index) => vector(index)) } });
    });
    const texts = Array.from({ length: 97 }, (_, index) => `document ${index}`);

    const vectors = await client.embedDocuments(texts);

    expect(vectors).toHaveLength(97);
    expect(requests).toHaveLength(2);
    expect(requests.map(({ body }) => (body.texts as string[]).length)).toEqual([96, 1]);
    expect(requests.every(({ url }) => url === "https://api.cohere.com/v2/embed")).toBe(true);
    expect(requests.map(({ body }) => body)).toEqual([
      {
        model: COHERE_EMBED_MODEL,
        input_type: "search_document",
        texts: texts.slice(0, 96),
        embedding_types: ["float"],
      },
      {
        model: COHERE_EMBED_MODEL,
        input_type: "search_document",
        texts: texts.slice(96),
        embedding_types: ["float"],
      },
    ]);
  });

  it("returns Cohere's rerank order as unique original document indices", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new CohereRetrievalClient("test-key", async (url, init) => {
      request = { url: String(url), init };
      return Response.json({ results: [
        { index: 2, relevance_score: 0.99 },
        { index: 0, relevance_score: 0.5 },
      ] });
    });
    const documents = ["first", "second", "third"];

    await expect(client.rerank("query", documents, 2)).resolves.toEqual([2, 0]);
    expect(request?.url).toBe("https://api.cohere.com/v2/rerank");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: COHERE_RERANK_MODEL,
      query: "query",
      documents,
      top_n: 2,
    });
  });

  it("clamps top_n to the document count and skips empty batches", async () => {
    const requestBodies: unknown[] = [];
    const client = new CohereRetrievalClient("test-key", async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ index: 0, relevance_score: 0.7 }] });
    });

    await expect(client.embedDocuments([])).resolves.toEqual([]);
    await expect(client.rerank("query", [], 3)).resolves.toEqual([]);
    await expect(client.rerank("query", ["only document"], 5)).resolves.toEqual([0]);
    expect(requestBodies).toEqual([{
      model: COHERE_RERANK_MODEL,
      query: "query",
      documents: ["only document"],
      top_n: 1,
    }]);
  });

  it("rejects malformed embedding vectors", async () => {
    const malformedPayloads: unknown[] = [
      {},
      { embeddings: { float: [] } },
      { embeddings: { float: [[1, 2]] } },
      { embeddings: { float: [Array.from({ length: 1024 }, () => Number.NaN)] } },
    ];
    for (const payload of malformedPayloads) {
      const client = new CohereRetrievalClient("test-key", async () => Response.json(payload));
      await expect(client.embedQuery("query")).rejects.toThrow("Cohere embed response");
    }
  });

  it("rejects malformed or duplicate rerank indices", async () => {
    const malformedPayloads: unknown[] = [
      {},
      { results: [{ index: -1, relevance_score: 0.9 }] },
      { results: [{ index: 1, relevance_score: 0.9 }] },
      { results: [{ index: 0, relevance_score: Number.NaN }] },
      { results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ] },
    ];
    for (const payload of malformedPayloads) {
      const client = new CohereRetrievalClient("test-key", async () => Response.json(payload));
      await expect(client.rerank("query", ["document"], 1)).rejects.toThrow("Cohere rerank response");
    }
  });

  it("does not expose response bodies, keys, or transport error details", async () => {
    const client = new CohereRetrievalClient("secret-key", async () =>
      new Response("secret response diagnostic", { status: 500 }));
    await expect(client.embedQuery("query")).rejects.toThrow("HTTP 500");
    await expect(client.embedQuery("query")).rejects.not.toThrow("secret response diagnostic");
    await expect(client.embedQuery("query")).rejects.not.toThrow("secret-key");

    const failingClient = new CohereRetrievalClient("secret-key", async () => {
      throw new Error("secret-key transport details");
    });
    await expect(failingClient.embedQuery("query")).rejects.toThrow("Cohere API request failed");
    await expect(failingClient.embedQuery("query")).rejects.not.toThrow("secret-key transport details");
  });

  it("rejects invalid constructor credentials and method inputs before calling the API", async () => {
    expect(() => new CohereRetrievalClient(" ")).toThrow("API key");
    let requests = 0;
    const client = new CohereRetrievalClient("test-key", async () => {
      requests += 1;
      return Response.json({});
    });

    await expect(client.embedQuery(" ")).rejects.toThrow("query");
    await expect(client.embedDocuments([""])).rejects.toThrow("document");
    await expect(client.rerank("query", ["document"], 0)).rejects.toThrow("topN");
    expect(requests).toBe(0);
  });
});

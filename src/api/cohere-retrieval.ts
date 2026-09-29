export const COHERE_EMBED_MODEL = "embed-english-v3.0";
export const COHERE_RERANK_MODEL = "rerank-english-v3.0";

const COHERE_API_BASE_URL = "https://api.cohere.com/v2";
const EMBEDDING_DIMENSIONS = 1024;
const MAX_EMBED_BATCH_SIZE = 96;
const REQUEST_TIMEOUT_MS = 30_000;

type CohereFetch = typeof fetch;

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Cohere ${label} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEmbeddingResponse(payload: unknown, expectedCount: number): number[][] {
  if (!isRecord(payload) || !isRecord(payload.embeddings)) {
    throw new Error("Cohere embed response was malformed");
  }
  const vectors = payload.embeddings.float;
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error("Cohere embed response was malformed");
  }

  return vectors.map((vector) => {
    if (!Array.isArray(vector)
      || vector.length !== EMBEDDING_DIMENSIONS
      || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Cohere embed response contained an invalid vector");
    }
    return vector;
  });
}

export class CohereRetrievalClient {
  private readonly apiKey: string;
  private readonly fetchImpl: CohereFetch;

  constructor(apiKey: string, fetchImpl: CohereFetch = fetch) {
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new Error("Cohere API key must be a non-empty string");
    }
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async embedQuery(query: string): Promise<number[]> {
    assertNonEmptyString(query, "query");
    const vectors = await this.embed([query], "search_query");
    return vectors[0]!;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts)) {
      throw new Error("Cohere documents must be an array of strings");
    }
    for (const text of texts) assertNonEmptyString(text, "document");
    if (texts.length === 0) return [];

    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + MAX_EMBED_BATCH_SIZE);
      vectors.push(...await this.embed(batch, "search_document"));
    }
    return vectors;
  }

  async rerank(query: string, documents: string[], topN: number): Promise<number[]> {
    assertNonEmptyString(query, "query");
    if (!Array.isArray(documents)) {
      throw new Error("Cohere documents must be an array of strings");
    }
    for (const document of documents) assertNonEmptyString(document, "document");
    if (!Number.isInteger(topN) || topN < 1) {
      throw new Error("Cohere rerank topN must be a positive integer");
    }
    if (documents.length === 0) return [];

    const payload = await this.request("/rerank", {
      model: COHERE_RERANK_MODEL,
      query,
      documents,
      top_n: Math.min(topN, documents.length),
    });
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new Error("Cohere rerank response was malformed");
    }

    const indices: number[] = [];
    const seen = new Set<number>();
    for (const result of payload.results) {
      if (!isRecord(result)
        || !Number.isInteger(result.index)
        || (result.index as number) < 0
        || (result.index as number) >= documents.length
        || typeof result.relevance_score !== "number"
        || !Number.isFinite(result.relevance_score)) {
        throw new Error("Cohere rerank response contained an invalid result");
      }
      const index = result.index as number;
      if (seen.has(index)) {
        throw new Error("Cohere rerank response contained duplicate indices");
      }
      seen.add(index);
      indices.push(index);
    }
    if (indices.length > Math.min(topN, documents.length)) {
      throw new Error("Cohere rerank response exceeded topN");
    }
    return indices;
  }

  private async embed(texts: string[], inputType: "search_query" | "search_document"):
  Promise<number[][]> {
    const payload = await this.request("/embed", {
      model: COHERE_EMBED_MODEL,
      input_type: inputType,
      texts,
      embedding_types: ["float"],
    });
    return parseEmbeddingResponse(payload, texts.length);
  }

  private async request(path: "/embed" | "/rerank", body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${COHERE_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Cohere API request failed");
    }

    if (!response.ok) {
      throw new Error(`Cohere API request failed with HTTP ${response.status}`);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new Error("Cohere API returned invalid JSON");
    }
  }
}

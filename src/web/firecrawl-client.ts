import { z } from "zod";

const firecrawlWebResultSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  description: z.string().optional(),
  markdown: z.string().optional(),
  publishedDate: z.string().optional(),
  metadata: z.object({
    title: z.string().optional(),
    sourceURL: z.string().optional(),
    description: z.string().optional(),
    publishedDate: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const firecrawlResponseSchema = z.object({
  success: z.literal(true),
  data: z.union([
    z.object({ web: z.array(firecrawlWebResultSchema).optional() }).passthrough(),
    z.array(firecrawlWebResultSchema),
  ]),
}).passthrough();

export interface FirecrawlSearchRequest {
  query: string;
  allowedDomains: string[];
  maxResults: number;
}

export interface FirecrawlSearchResult {
  url: string;
  title: string | undefined;
  description: string | undefined;
  markdown: string | undefined;
  publishedAt: string | undefined;
}

export interface FirecrawlSearchResponse {
  providerRequestId: string | null;
  results: FirecrawlSearchResult[];
}

export interface FirecrawlSearchClient {
  search(request: FirecrawlSearchRequest): Promise<FirecrawlSearchResponse>;
}

export interface HttpFirecrawlClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpFirecrawlClient implements FirecrawlSearchClient {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpFirecrawlClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(request: FirecrawlSearchRequest): Promise<FirecrawlSearchResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey !== undefined && this.apiKey !== "") {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: request.query,
        limit: request.maxResults,
        sources: ["web"],
        ...(request.allowedDomains.length === 0
          ? {}
          : { includeDomains: request.allowedDomains }),
        scrapeOptions: { formats: ["markdown"] },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const code = response.status === 402
        ? "firecrawl_credit_exhausted"
        : response.status === 429
          ? "firecrawl_rate_limited"
          : "firecrawl_request_failed";
      throw new FirecrawlRequestError(code, `Firecrawl search failed with HTTP ${response.status}`);
    }

    const parsed = firecrawlResponseSchema.parse(await response.json());
    const web = Array.isArray(parsed.data) ? parsed.data : (parsed.data.web ?? []);
    return {
      providerRequestId: response.headers.get("x-request-id"),
      results: web.map((item) => ({
        url: item.url,
        title: item.title ?? item.metadata?.title,
        description: item.description ?? item.metadata?.description,
        markdown: item.markdown,
        publishedAt: item.publishedDate ?? item.metadata?.publishedDate,
      })),
    };
  }
}

export class FirecrawlRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

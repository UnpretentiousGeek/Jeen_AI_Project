import { describe, expect, it, vi } from "vitest";

import {
  FirecrawlRequestError,
  HttpFirecrawlClient,
} from "../src/web/firecrawl-client.js";

describe("application-owned Firecrawl client", () => {
  it("uses only the search endpoint and sends the exact approved scope keylessly", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      success: true,
      data: {
        web: [{
          url: "https://regulator.example.gov/licenses/acme",
          title: "License record",
          markdown: "Acme holds license MT-1234.",
        }],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "fc-request-1" },
    }));
    const client = new HttpFirecrawlClient({ fetchImpl });

    const result = await client.search({
      query: "Acme money transmitter license",
      allowedDomains: ["regulator.example.gov"],
      maxResults: 5,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(options?.method).toBe("POST");
    expect(options?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(options?.body))).toEqual({
      query: "Acme money transmitter license",
      limit: 5,
      sources: ["web"],
      includeDomains: ["regulator.example.gov"],
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(result.providerRequestId).toBe("fc-request-1");
    expect(result.results).toHaveLength(1);
  });

  it("classifies rate-limit failures for the audit path", async () => {
    const client = new HttpFirecrawlClient({
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });

    await expect(client.search({ query: "query", allowedDomains: [], maxResults: 1 }))
      .rejects.toEqual(expect.objectContaining<Partial<FirecrawlRequestError>>({
        code: "firecrawl_rate_limited",
      }));
  });
});

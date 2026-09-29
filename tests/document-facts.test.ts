import type OpenAI from "openai";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createApiHandler } from "../src/api/http.ts";
import type { CaseApiService } from "../src/api/service.ts";
import {
  DocumentFactService, OpenAIDocumentFactExtractor,
  type DocumentFactExtractor,
} from "../src/facts/extraction-service.ts";

const caseId = "a0000000-0000-4000-8000-000000000001";
const documentId = "a0000000-0000-4000-8000-000000000002";
const chunkId = "a0000000-0000-4000-8000-000000000003";
const excerpt = "Account holder: Example Ltd";
const fact = {
  chunk_id: chunkId, subject: "Example Ltd", predicate: "account holder",
  value: "Example Ltd", excerpt,
};
const entityAttribute = {
  chunk_id: chunkId, subject: "Example Ltd", describes_document_subject: true,
  field: "legal_name", address_type: null,
  identifier_type: null, identifier_jurisdiction: null,
  value: "Example Ltd", excerpt, observed_at: null,
};
const ownershipEdge = {
  chunk_id: chunkId, owner: "Ada Example", owner_type: "person",
  owned: "Example Ltd", percentage: 60, holding: "direct", as_of: "2026-06-30",
  excerpt: "Ada Example owns 60% of Example Ltd",
};

function fakePool(
  content = `${excerpt}. ${ownershipEdge.excerpt}.`,
  otherChunks: Array<{ chunk_id: string; locator: string; content: string }> = [],
) {
  const transaction = { query: vi.fn(async (sql: string) => {
    if (sql.includes("save_case_document_facts")) {
      return { rows: [{ result: { requested_count: 1, inserted_count: 1, duplicate_count: 0 } }] };
    }
    if (sql.includes("INSERT INTO case_entity_attributes")
      || sql.includes("INSERT INTO case_ownership_edges")) {
      return { rows: [{ id: chunkId }] };
    }
    return { rows: [] };
  }), release: vi.fn() };
  const pool = {
    query: vi.fn().mockResolvedValueOnce({ rows: [{
      document_type: "bank_statement", fact_extraction_status: null, fact_count: 0,
    }] }).mockResolvedValueOnce({ rows: [{
      chunk_id: chunkId, locator: "Page 1", content,
    }, ...otherChunks] }),
    connect: vi.fn().mockResolvedValue(transaction),
  };
  return { pool: pool as unknown as Pool, transaction, connect: pool.connect };
}

type Transaction = ReturnType<typeof fakePool>["transaction"];

function savedClaims(transaction: Transaction) {
  const saved = (statement: string) => {
    const call = transaction.query.mock.calls.find(([sql]) => sql.includes(statement));
    return JSON.parse((call as unknown as [string, string[]])[1][3]!) as unknown[];
  };
  return {
    facts: saved("save_case_document_facts"),
    entity_attributes: saved("INSERT INTO case_entity_attributes"),
    ownership_edges: saved("INSERT INTO case_ownership_edges"),
  };
}

describe("document fact extraction", () => {
  it("uses a strict structured model response", async () => {
    const extraction = { facts: [fact], entity_attributes: [entityAttribute],
      ownership_edges: [ownershipEdge] };
    const parse = vi.fn().mockResolvedValue({ output_parsed: extraction });
    const extractor = new OpenAIDocumentFactExtractor({
      responses: { parse },
    } as unknown as OpenAI, "test-model");
    await expect(extractor.extract({
      document_type: "bank_statement",
      chunks: [{ chunk_id: chunkId, locator: "Page 1", content: `${excerpt}.` }],
    })).resolves.toEqual(extraction);
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      model: "test-model", store: false,
      text: { format: expect.any(Object) },
    }));
  });

  it("saves only facts with exact source quotations", async () => {
    const { pool, transaction, connect } = fakePool();
    const extractor = { model: "test-model", extract: vi.fn().mockResolvedValue({
      facts: [fact], entity_attributes: [entityAttribute], ownership_edges: [ownershipEdge],
    }) };
    const service = new DocumentFactService(pool, extractor);
    await expect(service.extract(caseId, documentId)).resolves.toMatchObject({
      status: "completed", fact_count: 1,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(transaction.query).toHaveBeenCalledWith(
      expect.stringContaining("save_case_document_facts"),
      [caseId, documentId, "test-model", JSON.stringify([fact])],
    );
    expect(transaction.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO case_entity_attributes"),
      [caseId, documentId, "test-model", JSON.stringify([entityAttribute])],
    );
    expect(transaction.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO case_ownership_edges"),
      [caseId, documentId, "test-model", JSON.stringify([ownershipEdge])],
    );
    expect(transaction.query).toHaveBeenCalledWith("COMMIT");
  });

  it("drops a fabricated quote and saves the verified claims", async () => {
    const { pool, transaction } = fakePool();
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({
        facts: [fact, { ...fact, excerpt: "Fabricated account holder" }],
        entity_attributes: [], ownership_edges: [],
      }),
    };
    await expect(new DocumentFactService(pool, extractor).extract(caseId, documentId))
      .resolves.toMatchObject({ status: "completed", dropped_claim_count: 1 });
    expect(savedClaims(transaction).facts).toEqual([fact]);
  });

  it("moves a quote to the chunk that contains it", async () => {
    const otherChunk = "a0000000-0000-4000-8000-000000000004";
    const funds = "Buyer payments are held by our regulated payment partner until payout.";
    const { pool, transaction } = fakePool(undefined, [
      { chunk_id: otherChunk, locator: "Page 1", content: `Funds flow\n${funds}` },
    ]);
    const misattributed = { ...fact, predicate: "funds holder", value: "payment partner", excerpt: funds };
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({
        facts: [misattributed, { ...misattributed, chunk_id: "not-a-chunk" }],
        entity_attributes: [], ownership_edges: [],
      }),
    };
    await expect(new DocumentFactService(pool, extractor).extract(caseId, documentId))
      .resolves.toMatchObject({ dropped_claim_count: 1 });
    expect(savedClaims(transaction).facts).toEqual([{ ...misattributed, chunk_id: otherChunk }]);
  });

  it("quotes the chunk's own text when the model collapsed table padding", async () => {
    const row = "| Business type           | Marketplace       |";
    const { pool, transaction } = fakePool(`Applicant details\n${row}`);
    const collapsed = { ...fact, predicate: "business type", value: "Marketplace",
      excerpt: "Business type | Marketplace" };
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({
        facts: [collapsed], entity_attributes: [], ownership_edges: [],
      }),
    };
    await new DocumentFactService(pool, extractor).extract(caseId, documentId);
    expect(savedClaims(transaction).facts).toEqual([
      { ...collapsed, excerpt: "Business type           | Marketplace" },
    ]);
  });

  it("stores which entity each attribute describes", async () => {
    const parentNumber = {
      ...entityAttribute, subject: "Example Holdings Ltd", describes_document_subject: false,
      field: "identifier", identifier_type: "company_number", value: "B-999",
      excerpt: "Example Holdings Ltd, company number B-999",
    };
    const { pool, transaction } = fakePool(`${excerpt}. ${parentNumber.excerpt}.`);
    const extractor = { model: "test-model", extract: vi.fn().mockResolvedValue({
      facts: [], entity_attributes: [entityAttribute, parentNumber], ownership_edges: [],
    }) };
    await new DocumentFactService(pool, extractor).extract(caseId, documentId);
    const [sql, params] = transaction.query.mock.calls.find(([statement]) =>
      statement.includes("INSERT INTO case_entity_attributes")) as unknown as [string, string[]];
    expect(sql).toContain("subject, describes_document_subject");
    expect(JSON.parse(params[3]!)).toEqual([entityAttribute, parentNumber]);
  });

  it("drops an entity attribute with a blank subject", async () => {
    const { pool, transaction } = fakePool();
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({
        facts: [], entity_attributes: [{ ...entityAttribute, subject: "  " }],
        ownership_edges: [],
      }),
    };
    await expect(new DocumentFactService(pool, extractor).extract(caseId, documentId))
      .resolves.toMatchObject({ dropped_claim_count: 1 });
    expect(savedClaims(transaction).entity_attributes).toEqual([]);
  });

  it("drops a typed ownership edge without an exact source quote", async () => {
    const { pool, transaction } = fakePool();
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({
        facts: [], entity_attributes: [], ownership_edges: [
          { ...ownershipEdge, excerpt: "Invented ownership statement" },
        ],
      }),
    };
    await expect(new DocumentFactService(pool, extractor).extract(caseId, documentId))
      .resolves.toMatchObject({ dropped_claim_count: 1 });
    expect(savedClaims(transaction).ownership_edges).toEqual([]);
  });

  it("saves an ownership date the model did not give as YYYY-MM-DD as unknown", async () => {
    const { pool, transaction } = fakePool();
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({
        facts: [], entity_attributes: [], ownership_edges: [{ ...ownershipEdge, as_of: "30 June 2026" }],
      }),
    };
    await new DocumentFactService(pool, extractor).extract(caseId, documentId);
    expect(savedClaims(transaction).ownership_edges).toEqual([{ ...ownershipEdge, as_of: null }]);
  });

  it("rejects a malformed model response before writing", async () => {
    const { pool, connect } = fakePool();
    const extractor: DocumentFactExtractor = {
      model: "test-model", extract: vi.fn().mockResolvedValue({ facts: [{ excerpt }] }),
    };
    await expect(new DocumentFactService(pool, extractor).extract(caseId, documentId))
      .rejects.toMatchObject({ code: "fact_extraction_invalid" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("routes extraction by case and document ID", async () => {
    const extract = vi.fn().mockResolvedValue({ status: "completed", fact_count: 1 });
    const handle = createApiHandler({
      service: {} as CaseApiService,
      documentFacts: { extract } as unknown as DocumentFactService,
      storageRoot: "/tmp",
    });
    const response = await handle(new Request(
      `http://localhost/api/cases/${caseId}/documents/${documentId}/facts/extract`,
      { method: "POST" },
    ));
    expect(response.status).toBe(200);
    expect(extract).toHaveBeenCalledWith(caseId, documentId);
  });
});

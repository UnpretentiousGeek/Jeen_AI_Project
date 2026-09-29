import { createHash } from "node:crypto";

import {
  type WebSearchAction,
  webSearchActionSchema,
} from "../contracts/analysis-snapshot.js";
import {
  type HumanReviewDecision,
  parseHumanReviewDecision,
} from "../contracts/human-review.js";
import {
  FirecrawlRequestError,
  type FirecrawlSearchClient,
  type FirecrawlSearchResult,
} from "./firecrawl-client.js";

export interface WebSearchProposal {
  reviewRequestId: string;
  caseId: string;
  analysisRunId: string;
  correlationId: string;
  action: WebSearchAction;
}

export interface WebSearchDecision extends HumanReviewDecision {
  executionId: string;
  expiresAt: string;
}

export interface ApprovedWebSearchScope {
  executionId: string;
  actionId: string;
  caseId: string;
  analysisRunId: string;
  query: string;
  allowedDomains: string[];
  maxResults: number;
  intendedUse: string;
  externalDisclosure: string[];
}

export interface StoredWebEvidence {
  id: string;
  searchExecutionId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  publisher: string;
  publishedAt: string | null;
  retrievedAt: string;
  excerpt: string;
  contentHash: string;
}

export type WebSearchClaim =
  | { outcome: "claimed"; scope: ApprovedWebSearchScope }
  | { outcome: "duplicate" };

export interface WebSearchStore {
  propose(proposal: WebSearchProposal): Promise<"stored" | "duplicate">;
  decide(decision: WebSearchDecision): Promise<"approved" | "rejected" | "changes_requested" | "duplicate">;
  claim(scope: ApprovedWebSearchScope, claimedAt: string): Promise<WebSearchClaim>;
  complete(input: {
    scope: ApprovedWebSearchScope;
    providerRequestId: string | null;
    evidence: StoredWebEvidence[];
    completedAt: string;
  }): Promise<void>;
  fail(input: {
    scope: ApprovedWebSearchScope;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  }): Promise<void>;
}

export interface AnalystAuthorization {
  actorId: string;
  roles: string[];
}

interface StoredApproval {
  proposal: WebSearchProposal;
  decision: WebSearchDecision;
  status: "approved" | "running" | "succeeded" | "failed";
  evidence: StoredWebEvidence[];
}

function stableScope(scope: ApprovedWebSearchScope): string {
  return JSON.stringify({
    executionId: scope.executionId,
    actionId: scope.actionId,
    caseId: scope.caseId,
    analysisRunId: scope.analysisRunId,
    query: scope.query,
    allowedDomains: scope.allowedDomains,
    maxResults: scope.maxResults,
    intendedUse: scope.intendedUse,
    externalDisclosure: scope.externalDisclosure,
  });
}

function scopeFrom(proposal: WebSearchProposal, executionId: string): ApprovedWebSearchScope {
  return {
    executionId,
    actionId: proposal.action.id,
    caseId: proposal.caseId,
    analysisRunId: proposal.analysisRunId,
    query: proposal.action.payload.query,
    allowedDomains: proposal.action.payload.allowed_domains,
    maxResults: proposal.action.payload.max_results,
    intendedUse: proposal.action.payload.intended_use,
    externalDisclosure: proposal.action.payload.external_disclosure,
  };
}

export class InMemoryWebSearchStore implements WebSearchStore {
  private readonly proposals = new Map<string, WebSearchProposal>();
  private readonly approvals = new Map<string, StoredApproval>();
  private readonly decisionsByAction = new Map<string, string>();

  async propose(proposal: WebSearchProposal): Promise<"stored" | "duplicate"> {
    const normalized = {
      ...proposal,
      action: webSearchActionSchema.parse(proposal.action),
    };
    const existing = this.proposals.get(normalized.action.id);
    if (existing === undefined) {
      this.proposals.set(normalized.action.id, structuredClone(normalized));
      return "stored";
    }
    if (JSON.stringify(existing) === JSON.stringify(normalized)) {
      return "duplicate";
    }
    throw new Error("web-search proposal conflicts with an existing action");
  }

  async decide(decision: WebSearchDecision): Promise<"approved" | "rejected" | "changes_requested" | "duplicate"> {
    const parsed = parseHumanReviewDecision(decision);
    const proposal = this.proposals.get(parsed.proposed_action_id);
    if (proposal === undefined
      || proposal.reviewRequestId !== parsed.request_id
      || proposal.caseId !== parsed.case_id
      || proposal.analysisRunId !== parsed.analysis_run_id) {
      throw new Error("review decision does not match the pending web-search proposal");
    }
    const fingerprint = JSON.stringify(decision);
    const existing = this.decisionsByAction.get(parsed.proposed_action_id);
    if (existing !== undefined) {
      if (existing === fingerprint) return "duplicate";
      throw new Error("web-search proposal has already received a different decision");
    }
    if (parsed.decision === "approved"
      && Date.parse(decision.expiresAt) <= Date.parse(parsed.decided_at)) {
      throw new Error("web-search approval expiry must be after its decision time");
    }
    this.decisionsByAction.set(parsed.proposed_action_id, fingerprint);
    if (parsed.decision !== "approved") return parsed.decision;
    this.approvals.set(decision.executionId, {
      proposal: structuredClone(proposal),
      decision: structuredClone(decision),
      status: "approved",
      evidence: [],
    });
    return "approved";
  }

  async claim(scope: ApprovedWebSearchScope, claimedAt: string): Promise<WebSearchClaim> {
    const approval = this.approvals.get(scope.executionId);
    if (approval === undefined) throw new Error("web search has no analyst approval");
    if (stableScope(scopeFrom(approval.proposal, scope.executionId)) !== stableScope(scope)) {
      throw new Error("web-search execution scope differs from the analyst-approved scope");
    }
    if (Date.parse(claimedAt) >= Date.parse(approval.decision.expiresAt)) {
      throw new Error("web-search approval has expired");
    }
    if (approval.status !== "approved") return { outcome: "duplicate" };
    approval.status = "running";
    return { outcome: "claimed", scope: structuredClone(scope) };
  }

  async complete(input: {
    scope: ApprovedWebSearchScope;
    providerRequestId: string | null;
    evidence: StoredWebEvidence[];
    completedAt: string;
  }): Promise<void> {
    const approval = this.approvals.get(input.scope.executionId);
    if (approval?.status !== "running") throw new Error("web-search execution is not running");
    approval.status = "succeeded";
    approval.evidence = structuredClone(input.evidence);
  }

  async fail(input: {
    scope: ApprovedWebSearchScope;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  }): Promise<void> {
    const approval = this.approvals.get(input.scope.executionId);
    if (approval?.status !== "running") throw new Error("web-search execution is not running");
    approval.status = "failed";
  }

  evidence(executionId: string): StoredWebEvidence[] {
    return structuredClone(this.approvals.get(executionId)?.evidence ?? []);
  }
}

export function proposeWebSearch(
  proposal: WebSearchProposal,
  store: WebSearchStore,
): Promise<"stored" | "duplicate"> {
  return store.propose({
    ...proposal,
    action: webSearchActionSchema.parse(proposal.action),
  });
}

export function submitWebSearchDecision(input: {
  decision: WebSearchDecision;
  authorization: AnalystAuthorization;
  store: WebSearchStore;
}): Promise<"approved" | "rejected" | "changes_requested" | "duplicate"> {
  const parsed = parseHumanReviewDecision(input.decision);
  if (!input.authorization.roles.includes("compliance_analyst")) {
    throw new Error("compliance analyst role is required to approve web search");
  }
  if (input.authorization.actorId !== parsed.decided_by) {
    throw new Error("decision actor does not match the authenticated analyst");
  }
  return input.store.decide(input.decision);
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function evidenceId(executionId: string, canonical: string): string {
  const hex = createHash("sha256").update(`${executionId}:${canonical}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function isAllowed(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const hostname = new URL(url).hostname.toLocaleLowerCase("en-US");
  return allowedDomains.some((domain) => {
    const normalized = domain.toLocaleLowerCase("en-US");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function excerptFrom(result: FirecrawlSearchResult): string {
  const source = result.markdown ?? result.description ?? "";
  return source.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function normalizeResults(
  scope: ApprovedWebSearchScope,
  results: FirecrawlSearchResult[],
  retrievedAt: string,
): StoredWebEvidence[] {
  const evidence = new Map<string, StoredWebEvidence>();
  for (const result of results) {
    if (!isAllowed(result.url, scope.allowedDomains)) {
      throw new Error(`Firecrawl returned a URL outside the approved domains: ${result.url}`);
    }
    const canonical = canonicalUrl(result.url);
    const excerpt = excerptFrom(result);
    if (excerpt === "") continue;
    const content = result.markdown ?? result.description ?? "";
    const publishedAt = result.publishedAt === undefined || Number.isNaN(Date.parse(result.publishedAt))
      ? null
      : new Date(result.publishedAt).toISOString();
    if (!evidence.has(canonical)) {
      evidence.set(canonical, {
        id: evidenceId(scope.executionId, canonical),
        searchExecutionId: scope.executionId,
        url: result.url,
        canonicalUrl: canonical,
        title: result.title?.trim() || new URL(result.url).hostname,
        publisher: new URL(result.url).hostname,
        publishedAt,
        retrievedAt,
        excerpt,
        contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      });
    }
  }
  return [...evidence.values()].slice(0, scope.maxResults);
}

export async function executeApprovedWebSearch(input: {
  scope: ApprovedWebSearchScope;
  store: WebSearchStore;
  firecrawl: FirecrawlSearchClient;
  now?: () => Date;
}): Promise<{ outcome: "executed"; evidence: StoredWebEvidence[] } | { outcome: "duplicate" }> {
  const now = input.now ?? (() => new Date());
  const claimedAt = now().toISOString();
  const claim = await input.store.claim(input.scope, claimedAt);
  if (claim.outcome === "duplicate") return claim;

  try {
    const response = await input.firecrawl.search({
      query: claim.scope.query,
      allowedDomains: claim.scope.allowedDomains,
      maxResults: claim.scope.maxResults,
    });
    const completedAt = now().toISOString();
    const evidence = normalizeResults(claim.scope, response.results, completedAt);
    await input.store.complete({
      scope: claim.scope,
      providerRequestId: response.providerRequestId,
      evidence,
      completedAt,
    });
    return { outcome: "executed", evidence };
  } catch (error) {
    const code = error instanceof FirecrawlRequestError ? error.code : "web_search_validation_failed";
    const message = error instanceof Error ? error.message : "unknown web-search failure";
    await input.store.fail({
      scope: claim.scope,
      errorCode: code,
      errorMessage: message,
      failedAt: now().toISOString(),
    });
    throw error;
  }
}
